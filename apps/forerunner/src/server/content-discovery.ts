import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { OperationOutput, WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { cut } from "@ai-outfitter/app-sdk/untrusted-text";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./items";
import { localDate, shiftDate } from "./review-period";
import { discoveryRecords } from "./schema";

type Host = WorkflowHost<"interactive">;
type Grant = OperationOutput<"discovery.grants">["grants"][number];
type Change = OperationOutput<"discovery.changes">["changes"][number];

const known = z.object({
  id: z.string(),
  path: z.string(),
  revision: z.string(),
  href: z.string(),
  changedAt: z.number(),
  excerpt: z.string(),
});
type Known = z.infer<typeof known>;
const stateSchema = z.object({
  checkpoint: z.string().nullable(), cursor: z.string().nullable(), items: z.array(known),
  pending: z.array(known).optional(),
});
type State = z.infer<typeof stateSchema>;
const empty: State = { checkpoint: null, cursor: null, items: [] };
const keepPerGrant = 30;
const maxPages = 4;
const maxBriefItems = 20;
const maxCitationBytes = 10_000;

export type ContentDiscovery = {
  items: (Known & { repository: string; grantKey: string })[];
  status: "ready" | "partial" | "unavailable" | "no-grants";
};

const personal = (who: AppIdentity) => who.canEdit && who.owner.kind === "user" && who.owner.id === who.userId;
const scope = (who: AppIdentity) => and(
  eq(discoveryRecords.installationId, who.installationId),
  eq(discoveryRecords.ownerId, who.userId),
  eq(discoveryRecords.kind, "content-grant"),
);

function updateItems(items: Known[], changes: Change[], cutoff: number) {
  const current = new Map(items.map(item => [item.path, item]));
  for (const change of changes) {
    if (change.kind === "archive") {
      current.delete(change.path);
      continue;
    }
    const changedAt = Date.parse(change.changedAt);
    current.set(change.path, {
      id: change.id, path: change.path, revision: change.revision, href: change.url, changedAt,
      excerpt: cut(change.body, 600),
    });
  }
  return [...current.values()].filter(item => item.changedAt >= cutoff)
    .sort((a, b) => b.changedAt - a.changedAt || a.path.localeCompare(b.path)).slice(0, keepPerGrant);
}

const grantKey = (grant: Grant) => JSON.stringify([grant.id, grant.provider, grant.repository, grant.ref, grant.path]);
const checkpointId = (who: AppIdentity, grant: Grant) =>
  stableGraphId("content-grant", who.installationId, who.userId, grantKey(grant));

async function removeRevoked(db: Database, who: AppIdentity, grants: Grant[], startedAt: number) {
  const ids = new Set(await Promise.all(grants.map(grant => checkpointId(who, grant))));
  const obsolete = and(scope(who), lt(discoveryRecords.createdAt, startedAt));
  const cached = await db.select({ id: discoveryRecords.id }).from(discoveryRecords).where(obsolete);
  for (const row of cached) {
    if (!ids.has(row.id)) await db.delete(discoveryRecords).where(and(obsolete, eq(discoveryRecords.id, row.id)));
  }
}

async function refreshGrant(db: Database, who: AppIdentity, host: Host, grant: Grant, now: number) {
  const id = await checkpointId(who, grant);
  const match = and(scope(who), eq(discoveryRecords.id, id));
  await db.insert(discoveryRecords).values({
    id, installationId: who.installationId, ownerId: who.userId, kind: "content-grant",
    data: JSON.stringify(empty), createdAt: now,
  }).onConflictDoNothing();
  for (let page = 0; page < maxPages; page++) {
    const [row] = await db.select({ data: discoveryRecords.data }).from(discoveryRecords).where(match);
    if (!row) throw new Error("Discovery checkpoint missing");
    const state = stateSchema.parse(JSON.parse(row.data));
    const update = (data: string) => db.update(discoveryRecords).set({ data })
      .where(and(match, eq(discoveryRecords.data, row.data))).returning({ id: discoveryRecords.id });
    const result = await host.call("discovery.changes", {
      grantId: grant.id,
      ...(state.checkpoint ? { checkpoint: state.checkpoint } : {}),
      ...(state.cursor ? { cursor: state.cursor } : {}),
    }).catch(async error => {
      if (!(error instanceof Response) || !state.cursor || error.status !== 410) throw error;
      await update(JSON.stringify({ ...state, cursor: null, pending: undefined }));
      return null;
    });
    if (!result) continue;
    if (result.changes.some(change => grant.path.endsWith("/") ? !change.path.startsWith(grant.path) : change.path !== grant.path))
      throw new Error("Discovery response exceeded its granted path");
    const items = updateItems(state.pending ?? state.items, result.changes, now - 3 * 86_400_000);
    const next = result.cursor
      ? { ...state, cursor: result.cursor, pending: items }
      : { checkpoint: result.checkpoint, cursor: null, items };
    const data = JSON.stringify(next);
    // A simultaneous connect and daily run may read the same page. Only one advances its checkpoint.
    if (data !== row.data && !(await update(data)).length) continue;
    if (!next.cursor) return { items: next.items, pending: false };
  }
  return { items: [], pending: true };
}

/** Joins only sources whose authorization is current. Never exposes a stored excerpt after a failed source read. */
export async function discoverPersonalContent(
  db: Database,
  who: AppIdentity,
  host: Host,
  input: { now: number; date?: string; timezone?: string; grantId?: string },
): Promise<ContentDiscovery> {
  if (!personal(who)) return { status: "unavailable", items: [] };
  const list = () => host.call("discovery.grants", {}).then(result => result.grants);
  const grants = await list().catch(() => null);
  if (!grants) return { status: "unavailable", items: [] };
  const selected = grants.filter(grant => !input.grantId || input.grantId === grant.id);
  if (!selected.length) {
    await removeRevoked(db, who, grants, input.now);
    return { status: "no-grants", items: [] };
  }
  const results: Awaited<ReturnType<typeof refreshGrant>>[] = [];
  for (const grant of selected) {
    const result = await refreshGrant(db, who, host, grant, input.now).catch(() => ({ items: [], pending: true }));
    results.push(result);
  }
  const current = await list().catch(() => null);
  if (!current) return { status: "unavailable", items: [] };
  await removeRevoked(db, who, current, input.now);
  const active = new Set(current.map(grantKey));
  const items = selected.flatMap((grant, index) => active.has(grantKey(grant))
    ? results[index].items.map(item => ({ ...item, repository: grant.repository, grantKey: grantKey(grant) })) : []);
  const timezone = input.timezone, date = input.date;
  const relevant = timezone && date
    ? items.filter(item => {
        const day = localDate(item.changedAt, timezone);
        return item.changedAt <= input.now && (day === date || day === shiftDate(date, -1));
      })
    : items;
  const ordered = relevant.sort((a, b) => b.changedAt - a.changedAt || a.path.localeCompare(b.path));
  const distinct = [...new Map(ordered.map(item => [item.href, item])).values()];
  const included: typeof distinct = [];
  let citationBytes = 0;
  for (const item of distinct.slice(0, maxBriefItems)) {
    citationBytes += new TextEncoder().encode(JSON.stringify([item.path, item.revision, item.href])).byteLength;
    if (citationBytes > maxCitationBytes) break;
    included.push(item);
  }
  return {
    status: results.some(result => result.pending) || selected.some(grant => !active.has(grantKey(grant))) || included.length < distinct.length
      ? "partial" : "ready",
    items: included,
  };
}

/** A grant can be revoked while the model is drafting. Check again before saving the brief. */
export async function contentStillAuthorized(host: Host, content: ContentDiscovery) {
  if (!content.items.length) return true;
  const active = await host.call("discovery.grants", {}).catch(() => null);
  if (!active) return false;
  const ids = new Set(active.grants.map(grantKey));
  return content.items.every(item => ids.has(item.grantKey));
}

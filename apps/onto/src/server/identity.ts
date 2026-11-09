import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { EntityRef } from "@ai-outfitter/app-sdk/entities";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { appRecordKey, userKey, userPrincipal } from "@ai-outfitter/onto/contracts";
import { core } from "../lib/graph";
import { graphEdges, graphNodes, graphTypes } from "./schema";
type Database = ReturnType<typeof installationDatabase>;

// An Outfitter principal is an OutfitterUser node keyed `ai-outfitter.com/users:<id>`,
// joined to the Person or Agent it belongs to by an active account_of edge.
const outfitterUser = "71000000-0000-4000-8000-000000000120";
const accountOf = "71000000-0000-4000-8000-000000000122";
const holders = [core.person, core.agent];
const kind = (typeId: string) => (typeId === core.agent ? ("agent" as const) : ("human" as const));
const account = alias(graphNodes, "account");

/** Active account_of links from Outfitter accounts to people and agents. */
function links(db: Database) {
  return db
    .select({ edgeId: graphEdges.id, accountId: account.id, key: account.externalKey, holderId: graphNodes.id, typeId: graphNodes.typeId })
    .from(graphEdges)
    .innerJoin(account, eq(account.id, graphEdges.fromId))
    .innerJoin(graphNodes, eq(graphNodes.id, graphEdges.toId))
    .where(and(
      eq(graphEdges.typeId, accountOf), eq(graphEdges.archived, false),
      eq(account.typeId, outfitterUser), eq(account.archived, false),
      eq(graphNodes.archived, false), inArray(graphNodes.typeId, holders),
    ));
}
const view = (row: { holderId: string; key: string | null; typeId: string }) => ({
  id: row.holderId, holderId: row.holderId, principalId: String(userPrincipal(row.key)), kind: kind(row.typeId),
});

/** The holder for the host's verified principal or app reference. Titles and bodies are never identities. */
export async function resolveIdentity(db: Database, input: { principalId: string; reference?: EntityRef }) {
  const { principalId, reference } = input;
  const linked = (await links(db).then((rows) => rows.filter((row) => row.key === userKey(principalId))))
    .map((row) => ({ id: row.holderId, typeId: row.typeId }));
  const sourced = reference
    ? await db.select({ id: graphNodes.id, typeId: graphNodes.typeId }).from(graphNodes)
        .where(and(eq(graphNodes.archived, false), eq(graphNodes.externalKey, appRecordKey(reference))))
    : [];
  // Both are verified evidence; conflicting holders stay blocked.
  const matches = [...new Map([...linked, ...sourced].map((row) => [row.id, row])).values()];
  if (matches.length > 1 || matches.some((row) => !holders.includes(row.typeId)))
    throw new Response("Ambiguous or invalid canonical identity", { status: 409 });
  const row = matches[0];
  return row ? { holderId: row.id, principalId, kind: kind(row.typeId) } : null;
}
export async function listIdentities(db: Database, who: AppIdentity) {
  requireEditor(who);
  return (await links(db)).map(view);
}
const archive = (db: Database, edgeIds: string[], who: AppIdentity) =>
  db.update(graphEdges).set({ archived: true, updatedBy: who.userId, updatedAt: Date.now() }).where(inArray(graphEdges.id, edgeIds));

export async function unlinkIdentity(db: Database, who: AppIdentity, holderId: string) {
  requireEditor(who);
  const edges = (await links(db)).filter((row) => row.holderId === holderId).map((row) => row.edgeId);
  if (edges.length) await archive(db, edges, who);
  return { removed: true };
}
/** One principal belongs to one holder and one holder has one principal. Grants nothing. */
export async function linkIdentity(
  db: Database,
  who: AppIdentity,
  input: { holderId: string; principalId: string; kind: "human" | "agent" },
) {
  requireEditor(who);
  const [holder] = await db
    .select({ typeId: graphNodes.typeId, slug: graphNodes.slug, title: graphNodes.title })
    .from(graphNodes)
    .innerJoin(graphTypes, eq(graphTypes.id, graphNodes.typeId))
    .where(and(eq(graphNodes.archived, false), eq(graphTypes.archived, false), eq(graphNodes.id, input.holderId)));
  if (holder?.typeId !== (input.kind === "human" ? core.person : core.agent))
    throw new Response("Identity type mismatch", { status: 409 });
  const key = userKey(input.principalId);
  const now = Date.now();
  const [existing] = await db.select({ id: graphNodes.id, typeId: graphNodes.typeId }).from(graphNodes).where(eq(graphNodes.externalKey, key));
  if (existing && existing.typeId !== outfitterUser) throw new Response("This key belongs to another record", { status: 409 });
  const accountId = existing?.id ?? crypto.randomUUID();
  const current = await links(db);
  const replaced = current.filter((row) => (row.key === key) !== (row.holderId === input.holderId)).map((row) => row.edgeId);
  const kept = current.some((row) => row.key === key && row.holderId === input.holderId);
  const taken = new Set((await db.select({ slug: graphNodes.slug }).from(graphNodes).where(eq(graphNodes.typeId, outfitterUser))).map((row) => row.slug));
  let slug = holder.slug;
  for (let n = 2; taken.has(slug); n++) slug = `${holder.slug}-${n}`;
  const audit = { createdBy: who.userId, updatedBy: who.userId, createdAt: now, updatedAt: now };
  const writes = [
    ...(existing ? [] : [db.insert(graphNodes).values({ id: accountId, typeId: outfitterUser, slug, title: holder.title, externalKey: key, ...audit })]),
    ...(replaced.length ? [archive(db, replaced, who)] : []),
    ...(kept ? [] : [db.insert(graphEdges).values({ id: crypto.randomUUID(), typeId: accountOf, fromId: accountId, toId: input.holderId, ...audit })]),
  ];
  if (writes.length) await db.batch(writes as unknown as Parameters<typeof db.batch>[0]);
  return { linked: true };
}

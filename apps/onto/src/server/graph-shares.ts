// Shares: what this graph shows another organization (docs/graph-sharing.md).
// A share names an Organization node, a saved KnowledgeGraph, the roots it is
// walked from and the nodes to hide. Every read walks current records, so a share
// holds a selection, never a copy. Editors change one with a merge patch; anyone
// who can read the graph can preview what the organization would see.

import { applyMergePatch, type MergePatch } from "@ai-outfitter/app-sdk/merge-patch";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { knowledgeGraphSelectInput } from "@ai-outfitter/app-sdk/graph-selection";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { isUuid, recordAddress } from "../lib/addresses";
import type { Database } from "./graph";
import { databaseSource } from "./graph-source";
import { rootIdsOf, selectKnowledgeGraphRecords } from "./knowledge-graph-select";
import { graphShares } from "./schema";

const address = z.string().min(3).max(300).regex(/^[^:\s]+:\S+$/, "Name a node as Type:slug").refine(value => !isUuid(value), "Name a node as Type:slug");
const keySet = z.record(address, z.literal(true));
export const shareState = z.strictObject({
  title: z.string().min(1).max(200),
  /** The Organization node the share is for, such as Organization:sunny. */
  organization: address,
  /** The saved KnowledgeGraph that decides which relationships, types and depth are shown. */
  graph: address,
  roots: keySet.refine(roots => Object.keys(roots).length > 0 && Object.keys(roots).length <= 20, "Name 1 to 20 roots"),
  hidden: keySet.default({}),
});
export type ShareState = z.infer<typeof shareState>;

export const shareSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, "Use lowercase letters, digits and dashes");
export const mutateShareInput = z.strictObject({
  slug: shareSlug,
  expectedRevision: z.number().int().nonnegative().describe("The revision you read; 0 creates the share."),
  patch: z.record(z.string(), z.unknown()).describe("Merge patch over {title, organization, graph, roots, hidden}; roots and hidden are {\"Type:slug\": true}, null removes a key."),
  archived: z.boolean().optional().describe("true stops the share; false starts it again."),
});

type Row = typeof graphShares.$inferSelect;
const summary = (row: Row) => ({ slug: row.slug, revision: row.revision, archived: row.archived, ...shareState.parse(row.state) });

export async function listShares(db: Database) {
  const rows = await db.select().from(graphShares).orderBy(asc(graphShares.title));
  return rows.map(summary);
}

/** The Organization node, KnowledgeGraph and roots must exist now; hidden nodes may be gone. */
async function checkState(db: Database, state: ShareState) {
  const source = databaseSource(db);
  const [organization, graph] = await rootIdsOf(source, [state.organization, state.graph]);
  const types = new Map((await source.types()).map(type => [type.id, type.name]));
  const [org, saved] = await source.nodes({ ids: [organization, graph] }).then(rows => [rows.find(row => row.id === organization), rows.find(row => row.id === graph)]);
  if (types.get(String(org?.typeId)) !== "Organization") throw new Response(`${state.organization} is not an Organization`, { status: 400 });
  if (types.get(String(saved?.typeId)) !== "KnowledgeGraph") throw new Response(`${state.graph} is not a KnowledgeGraph`, { status: 400 });
  await rootIdsOf(source, Object.keys(state.roots));
  if (Object.keys(state.roots).some(root => state.hidden[root])) throw new Response("A root cannot be hidden", { status: 400 });
}

/** Create or change a share. Only editors can: a share decides what another organization reads. */
export async function mutateShare(db: Database, identity: AppIdentity, raw: z.input<typeof mutateShareInput>) {
  if (!identity.canEdit) throw new Response("Only editors can share this graph", { status: 403 });
  const input = mutateShareInput.parse(raw);
  const [row] = await db.select().from(graphShares).where(eq(graphShares.slug, input.slug));
  const current = row?.revision ?? 0;
  if (input.expectedRevision !== current)
    throw new Response(`The share is at revision ${current}, not ${input.expectedRevision}. Read it again and rebuild the patch.`, { status: 409 });
  const before = row ? shareState.parse(row.state) : {};
  const parsed = shareState.safeParse(applyMergePatch(before, input.patch as MergePatch));
  if (!parsed.success) throw new Response(`The share is invalid: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "share"} ${issue.message}`).join("; ")}`, { status: 400 });
  const state = parsed.data;
  await checkState(db, state);
  const now = Date.now(), revision = current + 1;
  const values = { title: state.title, state, revision, archived: input.archived ?? row?.archived ?? false, updatedBy: identity.userId, updatedAt: now };
  const written = row
    ? await db.update(graphShares).set(values).where(and(eq(graphShares.slug, input.slug), eq(graphShares.revision, current))).returning()
    : await db.insert(graphShares).values({ slug: input.slug, ...values, createdBy: identity.userId, createdAt: now }).onConflictDoNothing().returning();
  if (!written.length) throw new Response("Someone else changed this share; read it again", { status: 409 });
  return summary(written[0]);
}

/** Nodes still connected to a root through selected edges without passing a hidden node. */
function withoutHidden(roots: string[], nodes: EntityRecord[], edges: EntityRecord[], hidden: ReadonlySet<string>) {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    const from = String(edge.attributes.fromId), to = String(edge.attributes.toId);
    if (hidden.has(from) || hidden.has(to)) continue;
    next.set(from, [...(next.get(from) ?? []), to]);
    next.set(to, [...(next.get(to) ?? []), from]);
  }
  const reached = new Set(roots.filter(root => !hidden.has(root)));
  for (const id of reached) for (const other of next.get(id) ?? []) reached.add(other);
  const kept = nodes.filter(node => reached.has(node.ref.id)), shown = new Set(kept.map(node => node.ref.id));
  // A truncated selection can return an edge whose far node it left out; show only edges between shown nodes.
  return { nodes: kept, edges: edges.filter(edge => shown.has(String(edge.attributes.fromId)) && shown.has(String(edge.attributes.toId))) };
}

/** Exactly what the share's organization would read: the KnowledgeGraph walked from the
 * roots over current records, hidden nodes and everything reached only through them left out. */
export async function readShare(db: Database, identity: AppIdentity, slug: string) {
  const [row] = await db.select().from(graphShares).where(eq(graphShares.slug, shareSlug.parse(slug)));
  if (!row) return null;
  const share = summary(row);
  if (share.archived) return { ...share, view: null };
  const source = databaseSource(db);
  const [graph] = await rootIdsOf(source, [share.graph]);
  const roots = await rootIdsOf(source, Object.keys(share.roots));
  const hiddenIds = new Set(await resolveSome(source, Object.keys(share.hidden)));
  const selection = await selectKnowledgeGraphRecords(db, identity, knowledgeGraphSelectInput.parse({ definitionId: graph, rootIds: roots }));
  const kept = withoutHidden(roots, selection.nodes, selection.edges, hiddenIds);
  const name = recordAddress({
    types: selection.types.map(type => type.attributes) as never,
    nodes: selection.nodes.map(node => node.attributes) as never,
    edges: selection.edges.map(edge => edge.attributes) as never,
  });
  return {
    ...share,
    view: {
      nodes: kept.nodes.map(node => ({ address: name("graph-node", node.ref.id), title: node.title, summary: (node.attributes.summary as string | null) ?? null })),
      edges: kept.edges.map(edge => ({ address: name("graph-edge", edge.ref.id) })),
      incomplete: selection.incomplete,
    },
  };
}

/** Hidden nodes that were archived or renamed since stay hidden by whatever still resolves. */
async function resolveSome(source: ReturnType<typeof databaseSource>, addresses: string[]) {
  const ids = await Promise.all(addresses.map(value => rootIdsOf(source, [value]).then(([id]) => id, () => null)));
  return ids.filter((id): id is string => !!id);
}

/** The Organization node's platform binding (its organization_id property). */
async function organizationBinding(db: Database, organization: string) {
  const source = databaseSource(db);
  const [id] = await rootIdsOf(source, [organization]).catch(() => [null]);
  const [node] = id ? await source.nodes({ ids: [id] }) : [];
  const bound = (node?.properties as Record<string, unknown> | undefined)?.organization_id;
  return typeof bound === "string" ? bound : null;
}

/** For a member of another organization (role external): the active shares whose Organization
 * node is bound (organization_id) to the caller's organization, and nothing else. Hidden nodes
 * are not named to them. */
export async function sharesFor(db: Database, identity: AppIdentity, slug?: string) {
  const caller = identity.callerOrganizationId;
  if (identity.role !== "external" || !caller) return [];
  const rows = (await db.select().from(graphShares).where(eq(graphShares.archived, false)).orderBy(asc(graphShares.title)))
    .filter(row => slug === undefined || row.slug === slug);
  const mine = [];
  for (const row of rows) if (await organizationBinding(db, shareState.parse(row.state).organization) === caller) {
    const share = await readShare(db, identity, row.slug);
    if (share) mine.push({ ...share, hidden: {} });
  }
  return mine;
}

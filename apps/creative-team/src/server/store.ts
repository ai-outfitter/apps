import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { brandQuestionIds, childLevel, draftFormats, draftStatuses, type MapLevel, mapLevels, sourceKinds } from "../lib/brand";
import { brandAnswers, contentProfile, drafts, mapNodes, sources } from "./schema";

// biome-ignore lint/suspicious/noExplicitAny: one query interface for D1 in the Worker and libSQL in tests.
export type Database = BaseSQLiteDatabase<"async", any>;

/** Writes need edit access: the owner of a personal installation, or an organization's owners and admins. */
export function requireWriter(identity: AppIdentity) {
  if (!identity.canEdit) throw new Response("Only the brand's editors can change it", { status: 403 });
}

const conflict = (what: string) => new Response(`Someone else changed this ${what}. Reload and try again.`, { status: 409 });
const missing = (what: string) => new Response(`${what} not found`, { status: 404 });
const id = z.string().min(1).max(64);
const revision = z.number().int().positive();
const text = (max: number) => z.string().max(max);

// ── Brand document ──────────────────────────────────────────────────────────

export const answerInput = z.strictObject({
  questionId: z.enum(brandQuestionIds),
  answer: text(8000),
  /** The revision the caller saw; omit for a question that has no answer yet. */
  revision: revision.optional(),
});

export async function saveAnswer(db: Database, identity: AppIdentity, input: z.input<typeof answerInput>, now = Date.now()) {
  requireWriter(identity);
  const change = answerInput.parse(input);
  const [current] = await db.select().from(brandAnswers).where(eq(brandAnswers.id, change.questionId));
  if (!current) {
    if (change.revision !== undefined) throw conflict("answer");
    const [row] = await db.insert(brandAnswers).values({ id: change.questionId, answer: change.answer.trim(), updatedBy: identity.userId, updatedAt: now })
      .onConflictDoNothing().returning();
    if (!row) throw conflict("answer");
    return row;
  }
  if (change.revision === undefined || change.revision !== current.revision) throw conflict("answer");
  const [row] = await db.update(brandAnswers).set({ answer: change.answer.trim(), revision: current.revision + 1, updatedBy: identity.userId, updatedAt: now })
    .where(and(eq(brandAnswers.id, change.questionId), eq(brandAnswers.revision, change.revision))).returning();
  if (!row) throw conflict("answer");
  return row;
}

// ── Content document ────────────────────────────────────────────────────────

const sourceFields = {
  kind: z.enum(sourceKinds),
  name: z.string().trim().min(1).max(200),
  platform: text(80).optional(),
  handle: text(200).optional(),
  url: z.string().trim().max(2000).refine((value) => value === "" || /^https?:\/\/\S+$/.test(value), "Use an http or https link").optional(),
  /** Posts, quotes or ideas pasted from the source. */
  examples: text(20000).optional(),
  /** What makes them unique: core ideas, voice and worldview. */
  notes: text(8000).optional(),
};
export const sourceInput = z.strictObject({ id: id.optional(), revision: revision.optional(), ...sourceFields });

export async function saveSource(db: Database, identity: AppIdentity, input: z.input<typeof sourceInput>, now = Date.now()) {
  requireWriter(identity);
  const { id: sourceId, revision: seen, ...fields } = sourceInput.parse(input);
  if (!sourceId) {
    const [row] = await db.insert(sources).values({ id: crypto.randomUUID(), ...fields, updatedBy: identity.userId, createdAt: now, updatedAt: now }).returning();
    return row;
  }
  if (seen === undefined) throw new Response("Name the revision you saw to change a source", { status: 400 });
  const [row] = await db.update(sources).set({ ...fields, revision: seen + 1, updatedBy: identity.userId, updatedAt: now })
    .where(and(eq(sources.id, sourceId), eq(sources.revision, seen))).returning();
  if (!row) throw (await exists(db, sources, sourceId)) ? conflict("source") : missing("Source");
  return row;
}

export const deleteInput = z.strictObject({ id, revision });

export async function deleteSource(db: Database, identity: AppIdentity, input: z.input<typeof deleteInput>) {
  requireWriter(identity);
  const change = deleteInput.parse(input);
  const [row] = await db.delete(sources).where(and(eq(sources.id, change.id), eq(sources.revision, change.revision))).returning({ id: sources.id });
  if (!row) throw (await exists(db, sources, change.id)) ? conflict("source") : missing("Source");
  return { id: row.id, deleted: true };
}

export const profileId = "content";
export const profileInput = z.strictObject({
  coreIdeas: text(8000).optional(),
  voice: text(8000).optional(),
  worldview: text(8000).optional(),
  patterns: text(8000).optional(),
  revision: revision.optional(),
});

/** The synthesis across every source; omitted fields keep what is saved. */
export async function saveProfile(db: Database, identity: AppIdentity, input: z.input<typeof profileInput>, now = Date.now()) {
  requireWriter(identity);
  const { revision: seen, ...fields } = profileInput.parse(input);
  const [current] = await db.select().from(contentProfile).where(eq(contentProfile.id, profileId));
  if (!current) {
    if (seen !== undefined) throw conflict("content document");
    const [row] = await db.insert(contentProfile).values({ id: profileId, ...fields, updatedBy: identity.userId, updatedAt: now }).onConflictDoNothing().returning();
    if (!row) throw conflict("content document");
    return row;
  }
  if (seen !== current.revision) throw conflict("content document");
  const [row] = await db.update(contentProfile).set({ ...fields, revision: seen + 1, updatedBy: identity.userId, updatedAt: now })
    .where(and(eq(contentProfile.id, profileId), eq(contentProfile.revision, seen))).returning();
  if (!row) throw conflict("content document");
  return row;
}

// ── Content map ─────────────────────────────────────────────────────────────

const nodeFields = {
  title: z.string().trim().min(1).max(300),
  notes: text(4000).optional(),
  /** What the node is based on: a reference post, a pattern seen performing, and where it came from. */
  research: text(4000).optional(),
};
// Four explicit levels rather than a recursive schema, so tools and review forms can be generated from it.
const angleNode = z.strictObject(nodeFields);
const ideaNode = z.strictObject({ ...nodeFields, children: z.array(angleNode).max(10).optional() });
const topicNode = z.strictObject({ ...nodeFields, children: z.array(ideaNode).max(12).optional() });
const pillarNode = z.strictObject({ ...nodeFields, children: z.array(topicNode).max(10).optional() });
type BranchNode = z.infer<typeof pillarNode>;

/**
 * Adds a branch to the map: pillars at the top (no parentId), or children under an
 * existing node, each with optional children of its own down to angles.
 */
export const branchInput = z.strictObject({
  parentId: id.nullish(),
  nodes: z.array(pillarNode).min(1).max(12),
});
const maxBranchNodes = 400;

export async function addBranch(db: Database, identity: AppIdentity, input: z.input<typeof branchInput>, now = Date.now()) {
  requireWriter(identity);
  const change = branchInput.parse(input);
  let level: MapLevel = "pillar";
  if (change.parentId) {
    const [parent] = await db.select().from(mapNodes).where(eq(mapNodes.id, change.parentId));
    if (!parent) throw missing("Map node");
    const below = childLevel[parent.level as MapLevel];
    if (!below) throw new Response("Angles are the last level of the map", { status: 400 });
    level = below;
  }
  const siblings = await db.select({ position: sql<number>`coalesce(max(${mapNodes.position}), -1)` }).from(mapNodes)
    .where(change.parentId ? eq(mapNodes.parentId, change.parentId) : isNull(mapNodes.parentId));
  const rows: (typeof mapNodes.$inferInsert)[] = [];
  const walk = (nodes: BranchNode[], parentId: string | null, at: MapLevel, start: number) => {
    nodes.forEach((node, index) => {
      const nodeId = crypto.randomUUID();
      rows.push({ id: nodeId, parentId, level: at, title: node.title, notes: node.notes ?? "", research: node.research ?? "", position: start + index,
        updatedBy: identity.userId, createdAt: now, updatedAt: now });
      const below = childLevel[at];
      if (node.children?.length) {
        if (!below) throw new Response("Angles are the last level of the map", { status: 400 });
        walk(node.children as BranchNode[], nodeId, below, 0);
      }
    });
  };
  walk(change.nodes, change.parentId ?? null, level, (siblings[0]?.position ?? -1) + 1);
  if (rows.length > maxBranchNodes) throw new Response(`Add at most ${maxBranchNodes} map nodes at once`, { status: 413 });
  // D1 binds at most 100 parameters per statement: 9 rows of 11 columns each.
  for (let i = 0; i < rows.length; i += 9) await db.insert(mapNodes).values(rows.slice(i, i + 9));
  return { added: rows.length, ids: rows.filter((row) => row.parentId === (change.parentId ?? null)).map((row) => row.id) };
}

export const nodeInput = z.strictObject({
  id,
  revision,
  title: nodeFields.title.optional(),
  notes: nodeFields.notes,
  research: nodeFields.research,
  /** Its order among its siblings, from 0. */
  position: z.number().int().min(0).max(1000).optional(),
});

export async function saveNode(db: Database, identity: AppIdentity, input: z.input<typeof nodeInput>, now = Date.now()) {
  requireWriter(identity);
  const { id: nodeId, revision: seen, ...fields } = nodeInput.parse(input);
  const [row] = await db.update(mapNodes).set({ ...fields, revision: seen + 1, updatedBy: identity.userId, updatedAt: now })
    .where(and(eq(mapNodes.id, nodeId), eq(mapNodes.revision, seen))).returning();
  if (!row) throw (await exists(db, mapNodes, nodeId)) ? conflict("map node") : missing("Map node");
  return row;
}

/** Removes a node and everything below it; drafts written from them stay, unlinked. */
export async function deleteNode(db: Database, identity: AppIdentity, input: z.input<typeof deleteInput>) {
  requireWriter(identity);
  const change = deleteInput.parse(input);
  const [node] = await db.select().from(mapNodes).where(eq(mapNodes.id, change.id));
  if (!node) throw missing("Map node");
  if (node.revision !== change.revision) throw conflict("map node");
  const ids = [node.id];
  for (let frontier = [node.id]; frontier.length;) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i += 90)
      next.push(...(await db.select({ id: mapNodes.id }).from(mapNodes).where(inArray(mapNodes.parentId, frontier.slice(i, i + 90)))).map((child) => child.id));
    frontier = next;
    ids.push(...frontier);
  }
  for (let i = 0; i < ids.length; i += 90) {
    const slice = ids.slice(i, i + 90);
    await db.update(drafts).set({ nodeId: null }).where(inArray(drafts.nodeId, slice));
    await db.delete(mapNodes).where(inArray(mapNodes.id, slice));
  }
  return { id: node.id, deleted: ids.length };
}

// ── Drafts ──────────────────────────────────────────────────────────────────

export const draftInput = z.strictObject({
  id: id.optional(),
  revision: revision.optional(),
  /** The idea or angle it was written from, if any. */
  nodeId: id.nullish(),
  format: z.enum(draftFormats),
  title: z.string().trim().min(1).max(300),
  body: text(20000),
  status: z.enum(draftStatuses).optional(),
});

export async function saveDraft(db: Database, identity: AppIdentity, input: z.input<typeof draftInput>, now = Date.now()) {
  requireWriter(identity);
  const { id: draftId, revision: seen, ...fields } = draftInput.parse(input);
  if (fields.nodeId && !(await exists(db, mapNodes, fields.nodeId))) throw missing("Map node");
  if (!draftId) {
    const [row] = await db.insert(drafts).values({ id: crypto.randomUUID(), ...fields, status: fields.status ?? "draft", updatedBy: identity.userId, createdAt: now, updatedAt: now }).returning();
    return row;
  }
  if (seen === undefined) throw new Response("Name the revision you saw to change a draft", { status: 400 });
  const [row] = await db.update(drafts).set({ ...fields, revision: seen + 1, updatedBy: identity.userId, updatedAt: now })
    .where(and(eq(drafts.id, draftId), eq(drafts.revision, seen))).returning();
  if (!row) throw (await exists(db, drafts, draftId)) ? conflict("draft") : missing("Draft");
  return row;
}

export async function deleteDraft(db: Database, identity: AppIdentity, input: z.input<typeof deleteInput>) {
  requireWriter(identity);
  const change = deleteInput.parse(input);
  const [row] = await db.delete(drafts).where(and(eq(drafts.id, change.id), eq(drafts.revision, change.revision))).returning({ id: drafts.id });
  if (!row) throw (await exists(db, drafts, change.id)) ? conflict("draft") : missing("Draft");
  return { id: row.id, deleted: true };
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function exists(db: Database, table: typeof sources | typeof mapNodes | typeof drafts, rowId: string) {
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, rowId));
  return Boolean(row);
}

export type BrandState = Awaited<ReturnType<typeof readState>>;

/** Everything the pages show: the brand and content documents, the map and the drafts. */
export async function readState(db: Database) {
  const [answers, sourceRows, [profile], nodes, draftRows] = await Promise.all([
    db.select().from(brandAnswers),
    db.select().from(sources).orderBy(asc(sources.kind), asc(sources.createdAt)).limit(200),
    db.select().from(contentProfile).where(eq(contentProfile.id, profileId)),
    db.select().from(mapNodes).orderBy(asc(mapNodes.position), asc(mapNodes.createdAt)).limit(2000),
    db.select().from(drafts).orderBy(desc(drafts.updatedAt)).limit(300),
  ]);
  return { answers, sources: sourceRows, profile: (profile ?? null) as typeof contentProfile.$inferSelect | null, nodes, drafts: draftRows };
}

export type MapTreeNode = (typeof mapNodes.$inferSelect) & { children: MapTreeNode[] };

/** The map as a tree, pillars first, in each level's saved order. */
export function mapTree(nodes: (typeof mapNodes.$inferSelect)[]): MapTreeNode[] {
  const byParent = new Map<string | null, MapTreeNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push({ ...node, children: [] });
    byParent.set(node.parentId, list);
  }
  const attach = (list: MapTreeNode[]): MapTreeNode[] => list.map((node) => ({ ...node, children: attach(byParent.get(node.id) ?? []) }));
  return attach(byParent.get(null) ?? []);
}

export const levelCounts = (nodes: { level: string }[]) =>
  Object.fromEntries(mapLevels.map((level) => [level, nodes.filter((node) => node.level === level).length])) as Record<MapLevel, number>;

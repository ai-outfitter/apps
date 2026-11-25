import {
  type AppActor,
  type AppIdentity,
  isResidentPrincipal,
  requireEditor,
  requireEntityWriter,
  sha256Hex,
} from "@ai-outfitter/app-sdk/server";
import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { readGraph } from "./graph";
import { addressIndex, resolveAddress } from "../lib/addresses";
import {
  applyGraphChanges,
  inspectGraphChanges,
  graphChangeInput,
} from "./graph-changes";
import { batchChangeRequests, graphBatches, graphBatchOperations, graphChanges, graphRevisions, ontoReviewJobs } from "./schema";
import { guardedBatch, guardedGraphBatch } from "./graph-batch";
import { isOrganizationCreate, organizationDuplicates } from "./organization-duplicates";
import { personalRoot } from "./owner-root";
import { wikiHome } from "./wiki-home";
import { requireAnsweredCitations } from "./batch-questions";
import { readSettings } from "./settings";

// Wiki change batches (docs/plans/wiki-change-batches.md). A batch stages
// graph.apply operations over many calls; nothing is visible to graph reads
// until an operation commits through applyGraphChanges, which also writes the
// history row. Policies decide what commits without a member: a confidence
// threshold, a review window that seals the rest, or a first discovery run.

import { batchOperationCap, batchExpiryMs, batchPolicy, batchOpenInput, batchAddInput, batchRemoveInput, batchIdInput, batchListInput, batchSubmitInput, batchReviewInput, recordHistoryInput, batchReviseInput, mutateBatchSubmissionInput, type BatchPolicy } from "@ai-outfitter/app-sdk/graph-contracts";
export { batchOperationCap, batchExpiryMs, policyThresholdFloor, batchPolicy, batchSource, batchOpenInput, batchAddInput, batchRemoveInput, batchIdInput, batchListInput, batchSubmitInput, batchReviewInput, recordHistoryInput, batchReviseInput, mutateBatchSubmissionInput, type BatchPolicy } from "@ai-outfitter/app-sdk/graph-contracts";
const operation = graphChangeInput.shape.operations.element;

export type Database = ReturnType<typeof installationDatabase>;
type BatchRow = typeof graphBatches.$inferSelect;
type OperationRow = typeof graphBatchOperations.$inferSelect;
type Operation = z.infer<typeof operation>;

function fail(message: string, status = 400): never {
  throw new Response(message, { status });
}

/** Reviews and member commits come from an authenticated member: either the member's own
 * session or the member's agent connection (an OAuth client the platform bound to that
 * member), acting with the member's identity. Apps, delegated entity writers and
 * resident agents never review. The actor and the origin of the chain must be the same
 * caller, so a review never arrives through an app in between. */
export function requireMemberReview(who: AppIdentity, actor: AppActor, origin: AppActor) {
  requireEditor(who);
  const ownAction = actor.kind === "member" ? actor.id === who.userId : actor.kind === "oauth-client";
  const sameCaller = origin.kind === actor.kind && origin.id === actor.id;
  if (!ownAction || !sameCaller || isResidentPrincipal(who.userId) || who.entityWriter)
    fail("Reviewing a batch requires an authenticated member or the member's own connection", 403);
}

/** How a decision records the member and, for an agent connection, which one. */
export const memberDecision = (who: AppIdentity, actor: AppActor, rest: Record<string, unknown>) => ({
  kind: "member", by: who.userId, via: actorRef(actor), ...(actor.label ? { viaLabel: actor.label } : {}), ...rest,
});

export async function loadBatch(db: Database, id: string) {
  const [batch] = await db.select().from(graphBatches).where(eq(graphBatches.id, id));
  if (!batch) fail("Batch not found", 404);
  return batch;
}
export const loadOperations = (db: Database, batchId: string) =>
  db.select().from(graphBatchOperations).where(eq(graphBatchOperations.batchId, batchId)).orderBy(asc(graphBatchOperations.position));

const touch = (db: Database, id: string, values: Partial<BatchRow>) =>
  db.update(graphBatches).set({ ...values, updatedAt: Date.now() }).where(eq(graphBatches.id, id));

/** Milliseconds until the end of the current local day in `zone`. */
export function untilEndOfDay(now: number, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(now)).map((part) => [part.type, part.value]),
  );
  const elapsed = (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
  return 24 * 3600 * 1000 - elapsed - 1000;
}

export function reviewDeadline(policy: BatchPolicy, now: number) {
  if (policy.kind !== "confidence" || !policy.reviewWindow) return null;
  return "hours" in policy.reviewWindow
    ? now + policy.reviewWindow.hours * 3600 * 1000
    : now + untilEndOfDay(now, policy.reviewWindow.timezone);
}

/** How a batch records who opened it. */
export const actorRef = (actor: AppActor) => `${actor.kind}:${actor.id}`;

export async function openBatch(db: Database, who: AppIdentity, actor: AppActor, input: z.infer<typeof batchOpenInput>) {
  requireEntityWriter(who);
  // Only an app (Forerunner) opens a batch that commits by policy, and only it fills one (requireOpen).
  if (input.policy.kind !== "member" && actor.kind !== "app") fail("Only an app opens a batch that commits by policy", 403);
  if (input.policy.kind === "first-run") await requireFirstRun(db, input.source?.kind);
  // Every batch is anchored to the root unless it names its own anchors; an empty list
  // asks for no connectivity requirement.
  const root = input.anchors === undefined ? await rootNode(db, who) : null;
  const anchors = root ? [root] : input.anchors?.length ? await anchorIds(db, who, input.anchors) : null;
  const now = Date.now();
  const id = crypto.randomUUID();
  await db.insert(graphBatches).values({
    id, title: input.title, purpose: input.purpose, source: input.source ?? null, policy: input.policy, anchors,
    state: "open", openedBy: who.userId, openedVia: actorRef(actor),
    createdAt: now, updatedAt: now, expiresAt: now + batchExpiryMs,
  });
  return getBatch(db, who, { batchId: id });
}

/** The node this Onto belongs to: the Organization bound to an organization's Onto, or the
 * owner's verified holder or canonical OutfitterUser account in a personal Onto. Null when none or
 * more than one matches; an unbound Onto then has no default anchor. */
export async function rootNode(db: Database, who: AppIdentity) {
  if (who.owner.kind === "user")
    return personalRoot(db, who);
  return wikiHome(await readGraph(db, who), who).organizationId ?? null;
}

/** The saved nodes a batch's anchors name. */
async function anchorIds(db: Database, who: AppIdentity, anchors: string[]) {
  const graph = await readGraph(db, who);
  const index = addressIndex(graph);
  return anchors.map((anchor) => {
    const id = resolveAddress(index, "graph-node", anchor);
    if (!graph.nodes.some((node) => node.id === id && !node.archived)) fail(`Unknown anchor ${anchor}`);
    return id;
  });
}

/** Every node the batch creates must reach an anchor along saved or staged edges, in
 * either direction and through any number of nodes. Returns the titles that do not. */
function unanchored(graph: Awaited<ReturnType<typeof readGraph>>, rows: OperationRow[], anchors: string[]) {
  return looseRows(graph, rows, anchors).map((row) => String((row.operation as { attributes?: Record<string, unknown> }).attributes?.title ?? row.ref));
}
/** The created-node rows that reach no anchor. */
function looseRows(graph: Awaited<ReturnType<typeof readGraph>>, rows: OperationRow[], anchors: string[]) {
  const index = addressIndex(graph);
  const op = (row: OperationRow) => row.operation as { type?: string; operation?: string; id?: string; attributes?: Record<string, unknown> };
  const idOf = (row: OperationRow) => {
    if (row.state === "committed" && row.recordId) return row.recordId;
    const change = op(row);
    return change.id ? index[change.type as keyof typeof index]?.get(change.id) ?? change.id : String(change.attributes?.id ?? row.ref);
  };
  const refs = new Map(rows.map((row) => [row.ref, idOf(row)]));
  const node = (value: unknown) => refs.get(String(value)) ?? index["graph-node"].get(String(value)) ?? String(value);
  const links = new Map<string, string[]>();
  const link = (a: string, b: string) => { links.set(a, [...(links.get(a) ?? []), b]); links.set(b, [...(links.get(b) ?? []), a]); };
  const edges = new Map<string, { fromId: string; toId: string; archived?: unknown }>(graph.edges.map(edge => [edge.id, edge]));
  const archived = new Set(graph.nodes.filter(node => node.archived).map(node => node.id));
  for (const row of rows) {
    if (row.state === "committed" || row.state === "rejected") continue;
    const change = op(row), attrs = change.attributes ?? {};
    if (change.type === "graph-node" && attrs.archived === true) archived.add(node(change.id ?? attrs.id ?? row.ref));
    if (change.type === "graph-node" && attrs.archived === false) archived.delete(node(change.id ?? attrs.id ?? row.ref));
    if (change.type !== "graph-edge") continue;
    const key = change.id ? index["graph-edge"].get(change.id) ?? change.id : idOf(row);
    const prior = edges.get(key);
    edges.set(key, { fromId: attrs.fromId === undefined ? prior?.fromId ?? "" : node(attrs.fromId), toId: attrs.toId === undefined ? prior?.toId ?? "" : node(attrs.toId), archived: attrs.archived ?? prior?.archived });
  }
  for (const edge of edges.values()) if (!edge.archived && !archived.has(edge.fromId) && !archived.has(edge.toId)) link(edge.fromId, edge.toId);
  const reached = new Set(anchors), queue = [...anchors];
  while (queue.length) for (const next of links.get(queue.pop()!) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next); }
  return rows.filter((row) => ["pending", "awaiting_review"].includes(row.state) && op(row).type === "graph-node" && op(row).operation === "create" && !op(row).attributes?.archived && !reached.has(idOf(row)));
}

/** A policy commits only what stays traceable: a created node reaches an anchor through
 * what is saved or commits with it, or it waits for a member with what depends on it. */
function anchoredSelection(graph: Awaited<ReturnType<typeof readGraph>>, rows: OperationRow[], selected: Set<string>, anchors: string[] | null) {
  if (!anchors?.length) return selected;
  for (;;) {
    const loose = looseRows(graph, rows.filter((row) => row.state === "committed" || selected.has(row.ref)), anchors);
    if (!loose.length) return selected;
    for (const row of loose) selected.delete(row.ref);
    closeSelection(rows, selected);
  }
}

/** First-run acceptance applies only before any policy batch of that source has committed;
 * a batch a member reviews (an agent's, say) does not use up the first run. */
async function requireFirstRun(db: Database, kind: string | undefined) {
  if (kind !== "discovery-run") fail("A first-run policy needs a discovery-run source");
  const earlier = await db.select({ source: graphBatches.source, policy: graphBatches.policy }).from(graphBatches)
    .where(inArray(graphBatches.state, ["open", "awaiting_review", "committed", "rejected"]));
  if (earlier.some((row) => (row.source as { kind?: string } | null)?.kind === kind && (row.policy as { kind?: string }).kind !== "member"))
    fail("This Wiki already has a discovery run; use the confidence policy", 409);
}

/** An open batch this caller may change. A batch that commits by policy (Forerunner's) takes
 * changes only from the app that opened it, never from an agent or a member's session. The
 * platform verifies the actor; an app calling another app's actions is {kind:"app"} and carries
 * no entity writer unless it holds entities.write.delegated, which Forerunner does not. */
export function requireOpen(batch: BatchRow, actor: AppActor) {
  if (batch.state !== "open") fail("The batch is no longer open", 409);
  if (batch.expiresAt <= Date.now()) fail("The batch has expired", 409);
  if ((batch.policy as { kind?: string }).kind !== "member" && (actor.kind !== "app" || batch.openedVia !== actorRef(actor)))
    fail("This batch commits by policy; stage changes in a batch a member reviews", 403);
}

/** Rows for proposals not yet in the batch. Retrying the same proposal is a no-op;
 * reusing a ref for another one is a conflict unless `replace` overwrites it in place. */
function newRows(batchId: string, existing: OperationRow[], proposals: z.infer<typeof batchAddInput>["proposals"], replace = false) {
  const byRef = new Map(existing.map((row) => [row.ref, row]));
  const added: OperationRow[] = [];
  let position = existing.length ? existing[existing.length - 1].position + 1 : 0;
  for (const item of proposals) {
    const saved = byRef.get(item.operation.ref);
    const operation = item.operation as unknown as Record<string, unknown>;
    const live = saved && saved.state !== "removed";
    if (live && !replace && JSON.stringify(saved.operation) === JSON.stringify(operation)) continue;
    if (live && !replace) fail(`Reference ${item.operation.ref} is already used in this batch`, 409);
    if (added.some(row => row.ref === item.operation.ref)) fail(`Duplicate proposal ref ${item.operation.ref}`);
    added.push({
      batchId, ref: item.operation.ref, position: live ? saved.position : position++, operation,
      evidence: item.evidence, confidence: item.confidence ?? null, reason: item.reason ?? null, state: "pending",
      decidedBy: null, decision: null, recordId: null, recordRevision: null,
    });
  }
  return added;
}

async function writeDraft(db: Database, who: AppIdentity, batch: BatchRow, existing: OperationRow[], statements: SQL[]) {
  const guard = `draft:${crypto.randomUUID()}`, now = Date.now();
  await guardedBatch(db, [
    sql`INSERT INTO graph_changes(userId,requestKey,hash,attempt,receipt)
      VALUES(${who.userId},${guard},'draft',CASE WHEN ${batchRowsUnchanged(batch, existing)} AND ${batch.expiresAt} > ${now} THEN ${guard} ELSE NULL END,'{}')`,
    ...statements,
    sql`UPDATE graph_batches SET updatedAt=${now} WHERE id=${batch.id}`,
    sql`DELETE FROM graph_changes WHERE userId=${who.userId} AND requestKey=${guard}`,
  ], "Batch changed; reload before editing the draft");
}

export async function addToBatch(db: Database, who: AppIdentity, actor: AppActor, input: z.infer<typeof batchAddInput>) {
  requireEntityWriter(who);
  if (input.proposals.some((item) => item.operation.type === "graph-type")) requireEditor(who);
  const batch = await loadBatch(db, input.batchId);
  requireOpen(batch, actor);
  await requireAnsweredCitations(db, input.proposals.flatMap(item => item.evidence));
  const existing = await loadOperations(db, batch.id);
  if (input.replace && existing.some(row => row.operation.type === "graph-type" &&
      input.proposals.some(item => item.operation.ref === row.ref))) requireEditor(who);
  const added = newRows(batch.id, existing, input.proposals, input.replace);
  const liveRefs = new Set(live(existing).map((row) => row.ref));
  const replaced = added.filter((row) => liveRefs.has(row.ref)).length;
  const operations = liveRefs.size + added.length - replaced;
  if (operations > batchOperationCap)
    fail(`A batch holds at most ${batchOperationCap} operations`, 413);
  if (added.length) await writeDraft(db, who, batch, existing, writeProposals(batch.id, added, []));
  return { batchId: batch.id, added: added.length - replaced, operations };
}

export async function removeFromBatch(db: Database, who: AppIdentity, actor: AppActor, input: z.infer<typeof batchRemoveInput>) {
  requireEntityWriter(who);
  const batch = await loadBatch(db, input.batchId);
  requireOpen(batch, actor);
  const existing = await loadOperations(db, batch.id);
  if (existing.some(row => row.operation.type === "graph-type" && input.refs.includes(row.ref))) requireEditor(who);
  await writeDraft(db, who, batch, existing, writeProposals(batch.id, [], input.refs));
  return getBatch(db, who, { batchId: batch.id });
}

export const batchConfigureInput = z.strictObject({ batchId: z.uuid(), anchors: batchOpenInput.shape.anchors.unwrap() });
export async function configureBatch(db: Database, who: AppIdentity, actor: AppActor, input: z.infer<typeof batchConfigureInput>) {
  requireEntityWriter(who);
  const batch = await loadBatch(db, input.batchId);
  if (batch.state === "open") requireOpen(batch, actor);
  else if (batch.state !== "awaiting_review" || batch.policy.kind !== "member") fail("Anchors can only change in an open batch or a batch awaiting member review", 409);
  const anchors = await anchorIds(db, who, input.anchors);
  if (batch.state === "awaiting_review") {
    const rows = live(await loadOperations(db, batch.id));
    if (rows.some(row => row.state !== "awaiting_review")) fail("Anchors are fixed once review decisions are made", 409);
    const loose = anchors.length ? unanchored(await readGraph(db, who), rows, anchors) : [];
    if (loose.length) fail(`These proposals do not connect to the selected anchors: ${loose.slice(0, 20).join(", ")}`, 409);
  }
  await db.update(graphBatches).set({ anchors: anchors.length ? anchors : null, updatedAt: Date.now() }).where(and(eq(graphBatches.id, batch.id), eq(graphBatches.state, batch.state), sql`not exists (select 1 from graph_batch_operations where batchId = ${batch.id} and state in ('committed', 'rejected'))`));
  return getBatch(db, who, input);
}

export const live = (rows: OperationRow[]) => rows.filter((row) => row.state !== "removed");
/** Stable across policy decisions, which may change operation state after submission. */
export const batchContentDigest = (rows: OperationRow[]) => sha256Hex(JSON.stringify(live(rows).map(({ ref, position, operation, evidence, confidence, reason }) => ({ ref, position, operation, evidence, confidence, reason }))));
const asOperation = (row: OperationRow) => row.operation as unknown as Operation;

/** The refs and created record IDs an operation needs from elsewhere in its batch. */
function dependencies(row: OperationRow, createdBy: Map<string, string>) {
  const op = asOperation(row);
  const values: unknown[] = [op.attributes.typeId, op.attributes.fromId, op.attributes.toId];
  try {
    const body = typeof op.attributes.body === "string" ? JSON.parse(op.attributes.body) : null;
    values.push(body?.subject?.id);
  } catch {}
  const refs = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (value.startsWith("$")) refs.add(value);
    else if (createdBy.has(value) && createdBy.get(value) !== row.ref) refs.add(createdBy.get(value)!);
  }
  return refs;
}
function createdIds(rows: OperationRow[]) {
  return new Map(rows.flatMap((row) => {
    const op = asOperation(row);
    return op.operation === "create" && typeof op.attributes.id === "string" ? [[op.attributes.id, row.ref] as const] : [];
  }));
}

/** Replace refs to already committed operations with their record IDs. */
export function resolveCommitted(row: OperationRow, committed: Map<string, string>): Operation {
  const op = structuredClone(asOperation(row));
  for (const field of ["typeId", "fromId", "toId"]) {
    const value = op.attributes[field];
    if (typeof value === "string" && committed.has(value)) op.attributes[field] = committed.get(value)!;
  }
  if (typeof op.attributes.body === "string" && op.attributes.body.includes('"$')) {
    try {
      const body = JSON.parse(op.attributes.body);
      if (typeof body?.subject?.id === "string" && committed.has(body.subject.id)) {
        body.subject.id = committed.get(body.subject.id);
        op.attributes.body = JSON.stringify(body);
      }
    } catch {}
  }
  return op;
}

/** Selected operations plus nothing else: an operation whose dependency is not selected or committed waits. */
function closeSelection(rows: OperationRow[], selected: Set<string>) {
  const createdBy = createdIds(rows);
  const states = new Map(rows.map((row) => [row.ref, row.state]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!selected.has(row.ref)) continue;
      const missing = [...dependencies(row, createdBy)].some((dep) => states.has(dep) && states.get(dep) !== "committed" && !selected.has(dep));
      if (missing) { selected.delete(row.ref); changed = true; }
    }
  }
  return selected;
}

type Approval = Record<string, unknown>;

/** Commit chosen operations in one graph.apply per 100, recording batch, evidence and approval. */
async function commitOperations(db: Database, who: AppIdentity, batch: BatchRow, rows: OperationRow[], refs: Set<string>, approval: (row: OperationRow) => Approval) {
  const committed = new Map(rows.filter((row) => row.state === "committed" && row.recordId).map((row) => [row.ref, row.recordId!]));
  const chosen = rows.filter((row) => refs.has(row.ref) && row.state !== "committed");
  for (let start = 0; start < chosen.length; start += 100) {
    const chunk = chosen.slice(start, start + 100);
    const operations = chunk.map((row) => resolveCommitted(row, committed));
    // Keyed by the chunk's refs: two concurrent commits of the same operations
    // replay one receipt, and different operations never share a key.
    const requestKey = `batch:${batch.id}:${(await batchContentDigest(chunk)).slice(0, 32)}`;
    // One approval describes the chunk in history; per-operation detail stays on the batch rows.
    const receipt = await applyGraphChanges(db, who, { requestKey, operations }, {
      batchId: batch.id,
      proposedBy: batch.openedBy,
      approval: approval(chunk[0]),
      evidence: Object.fromEntries(chunk.map((row) => [row.ref, row.evidence])),
      precondition: reviewedRowsUnchanged(batch, chunk),
      finalize: (saved, gate) => [
        ...chunk.map(row => sql`UPDATE graph_batch_operations SET state='committed',recordId=${saved[row.ref].id},recordRevision=${saved[row.ref].revision},decision=${JSON.stringify(approval(row))},decidedBy=${approval(row).kind === "member" ? who.userId : null}
          WHERE batchId=${batch.id} AND ref=${row.ref} AND ${gate}`),
        sql`UPDATE graph_batches SET commits=commits+1,updatedAt=${Date.now()} WHERE id=${batch.id} AND ${gate}`,
      ],
    });
    for (const row of chunk) {
      const saved = receipt[row.ref];
      committed.set(row.ref, saved.id);
    }
  }
  return chosen.length;
}

/** Amendments refresh reviewJobId. Exact selected row snapshots also protect
 * decisions against another reviewer or writer without relying on timestamps. */
function reviewedRowsUnchanged(batch: BatchRow, rows: OperationRow[]) {
  const snapshot = JSON.stringify(rows.map(row => ({ ...row, operation: JSON.stringify(row.operation), evidence: JSON.stringify(row.evidence) })));
  return sql`exists (select 1 from graph_batches where id=${batch.id} and state=${batch.state} and submittedVersion=${batch.submittedVersion} and reviewJobId is ${batch.reviewJobId})
    and not exists (select 1 from json_each(${snapshot}) e left join graph_batch_operations r
      on r.batchId=${batch.id} and r.ref=json_extract(e.value,'$.ref') where r.ref is null
      or r.state is not json_extract(e.value,'$.state') or r.operation is not json_extract(e.value,'$.operation')
      or r.evidence is not json_extract(e.value,'$.evidence') or r.confidence is not json_extract(e.value,'$.confidence')
      or r.reason is not json_extract(e.value,'$.reason')
      or r.decision is not json_extract(e.value,'$.decision'))`;
}

async function settle(db: Database, batchId: string) {
  const rows = live(await loadOperations(db, batchId));
  const waiting = rows.some((row) => row.state === "pending" || row.state === "awaiting_review");
  if (waiting) return;
  const state = rows.some((row) => row.state === "committed") || !rows.length ? "committed" : "rejected";
  await db.update(graphBatches).set({ state, closedAt: Date.now(), reviewBy: null, updatedAt: Date.now() })
    .where(and(eq(graphBatches.id, batchId), sql`not exists (select 1 from graph_batch_operations where batchId=${batchId} and state in ('pending','awaiting_review'))`));
}

const policyApproval = (policy: BatchPolicy, reason: string) => (row: OperationRow): Approval => ({
  kind: "policy", policy: policy.kind, ...("version" in policy ? { version: policy.version } : {}),
  ...(policy.kind === "confidence" ? { threshold: policy.threshold } : {}),
  score: row.confidence, reason,
});

function summarize(rows: OperationRow[], types: Map<string, string>) {
  const counts: Record<string, number> = {};
  let evidence = 0;
  for (const row of rows) {
    const op = asOperation(row);
    const typeName = types.get(String(op.attributes.typeId)) ?? (op.type === "graph-edge" ? "relationship" : op.type === "graph-type" ? "type" : "record");
    const key = `${op.operation === "update" ? "updated " : ""}${typeName}`;
    counts[key] = (counts[key] ?? 0) + 1;
    evidence += Array.isArray(row.evidence) ? row.evidence.length : 0;
  }
  return { counts, evidence, operations: rows.length };
}

function proposalSnapshot(rows: OperationRow[]) {
  return live(rows).map(({ ref, operation, evidence, reason, confidence }) => ({ ref, operation, evidence, reason, confidence }));
}

export async function submitBatch(db: Database, who: AppIdentity, actor: AppActor, input: z.infer<typeof batchSubmitInput>) {
  requireEntityWriter(who);
  const batch = await loadBatch(db, input.batchId);
  requireOpen(batch, actor);
  const rows = live(await loadOperations(db, batch.id));
  const graph = await readGraph(db, who);
  const types = new Map(graph.types.map((type) => [type.id, type.name]));
  const summary = { ...summarize(rows, types), text: input.summary ?? null };
  const policy = batchPolicy.parse(batch.policy);
  if (rows.length) {
    const validation = await validateBatch(db, who, { batchId: batch.id });
    if (!validation.valid) fail(`Fix the batch before submitting it: ${validation.error}`, 409);
    // A member batch must connect before submit; a policy batch leaves what does not for a member.
    const loose = policy.kind === "member" && batch.anchors?.length ? unanchored(graph, rows, batch.anchors) : [];
    if (loose.length) fail(`Connect these to an anchor before submitting: ${loose.slice(0, 20).join(", ")}`, 409);
  }
  const now = Date.now();
  const contentDigest = await batchContentDigest(rows);
  const reused = (await reusableDraftReview(db, batch, contentDigest))?.id ?? null;
  const jobId = reused ?? crypto.randomUUID();
  // D1 batch executes these statements atomically: no submitted batch can lose its review work.
  const guard = `submit:${crypto.randomUUID()}`;
  await guardedGraphBatch(db, who, graph, [
    sql`INSERT INTO graph_changes(userId,requestKey,hash,attempt,receipt)
      VALUES(${who.userId},${guard},'submit',CASE WHEN ${reviewedRowsUnchanged(batch, rows)}
        AND (SELECT count(*) FROM graph_batch_operations WHERE batchId=${batch.id} AND state!='removed')=${rows.length}
        AND EXISTS (SELECT 1 FROM graph_batches WHERE id=${batch.id} AND anchors IS ${batch.anchors ? JSON.stringify(batch.anchors) : null})
        THEN ${guard} ELSE NULL END,'{}')`,
    sql`UPDATE graph_batch_operations SET state='awaiting_review' WHERE batchId=${batch.id} AND state='pending'`,
    submissionStatement(batch.id, 1, rows, who.userId, actor, now),
    sql`UPDATE graph_batches SET submittedVersion=1,state='awaiting_review',summary=${JSON.stringify(summary)},
      reviewBy=${reviewDeadline(policy, now)},updatedAt=${now},reviewJobId=${jobId},
      review=CASE WHEN ${reused} IS NULL THEN NULL ELSE review END WHERE id=${batch.id}`,
    ...(reused ? [] : [sql`INSERT INTO onto_review_jobs(id,batchId,contentDigest,state,nextAttemptAt,createdAt,runId)
      VALUES(${jobId},${batch.id},${contentDigest},'pending',${now},${now},${crypto.randomUUID()})`]),
    sql`DELETE FROM graph_changes WHERE userId=${who.userId} AND requestKey=${guard}`,
  ], "Batch or graph changed; reload before submitting");
  const submitted = { ...batch, submittedVersion: 1, state: "awaiting_review", commits: batch.commits, reviewJobId: jobId };
  const waiting = live(await loadOperations(db, batch.id));
  if (policy.kind === "first-run" || policy.kind === "confidence") {
    const eligible = new Set(waiting.filter(row => row.state === "awaiting_review" && !changesRequested(row) &&
      (policy.kind === "first-run" || (row.confidence ?? 0) >= policy.threshold)).map(row => row.ref));
    for (const duplicate of organizationDuplicates(graph, waiting)) eligible.delete(duplicate.ref);
    const chosen = anchoredSelection(graph, waiting, closeSelection(waiting, eligible), batch.anchors);
    await commitByPolicy(db, who, submitted, waiting, chosen, policyApproval(policy, policy.kind));
  }
  await settle(db, batch.id);
  if (reused) await approveCompletedDraftReview(db, who, batch.id, reused);
  return getBatch(db, who, { batchId: batch.id });
}

async function reusableDraftReview(db: Database, batch: BatchRow, digest: string) {
  if (batch.state !== "open" || !batch.reviewJobId) return;
  const [draft] = await db.select().from(ontoReviewJobs).where(eq(ontoReviewJobs.id, batch.reviewJobId));
  if (draft?.contentDigest === digest && ["pending", "running", "complete"].includes(draft.state)) return draft;
}

async function approveCompletedDraftReview(db: Database, who: AppIdentity, batchId: string, jobId: string) {
  const [[job], fresh] = await Promise.all([
    db.select({ state: ontoReviewJobs.state }).from(ontoReviewJobs).where(eq(ontoReviewJobs.id, jobId)),
    loadBatch(db, batchId),
  ]);
  if (job?.state === "complete" && fresh.review?.state === "complete")
    await approveAfterReview(db, who, batchId, jobId, fresh.review);
}

/** A policy subset that fails validation commits nothing and waits for a member. */
async function commitByPolicy(db: Database, who: AppIdentity, batch: BatchRow, rows: OperationRow[], refs: Set<string>, approval: (row: OperationRow) => Approval) {
  if (!refs.size) return 0;
  try {
    return await commitOperations(db, who, batch, rows, refs, approval);
  } catch (error) {
    if (error instanceof Response && error.status < 500) return 0;
    throw error;
  }
}

export async function validateBatch(db: Database, who: AppIdentity, input: z.infer<typeof batchIdInput>) {
  const batch = await loadBatch(db, input.batchId);
  const rows = live(await loadOperations(db, batch.id));
  return validateRows(db, who, batch, rows);
}

async function validateRows(db: Database, who: AppIdentity, batch: Pick<BatchRow, "id" | "policy" | "anchors">, rows: OperationRow[]) {
  const committed = new Map(rows.filter((row) => row.state === "committed" && row.recordId).map((row) => [row.ref, row.recordId!]));
  const operations = rows.filter((row) => row.state !== "committed" && row.state !== "rejected").map((row) => resolveCommitted(row, committed));
  if (!operations.length) return { valid: true as const, error: null, operations: 0 };
  try {
    // The whole batch at once, so refs from earlier add calls resolve. Validation
    // writes nothing, so the 100-operation limit of a single apply does not apply.
    await inspectGraphChanges(db, who, { requestKey: `validate:${batch.id}`, operations });
    // Policy batches may hold loose records: they wait for a member instead of committing.
    const loose = batchPolicy.parse(batch.policy).kind === "member" && batch.anchors?.length ? unanchored(await readGraph(db, who), rows.filter(row => row.state !== "rejected"), batch.anchors) : [];
    return { valid: loose.length === 0, error: loose.length ? `Connect these to an anchor before submitting: ${loose.slice(0, 20).join(", ")}` : null, operations: operations.length };
  } catch (error) {
    if (!(error instanceof Response) || error.status >= 500) throw error;
    return { valid: false as const, error: (await error.text()).slice(0, 2000), operations: operations.length };
  }
}

type ProposalEdit = Pick<z.infer<typeof batchReviseInput>, "proposals" | "remove">;

async function proposedRows(db: Database, who: AppIdentity, batchId: string, batch: BatchRow | undefined, input: ProposalEdit, state: string) {
  await requireAnsweredCitations(db, input.proposals.flatMap(item => item.evidence));
  const existing = batch ? await loadOperations(db, batch.id) : [];
  const byRef = new Map(existing.map(row => [row.ref, row]));
  if (input.proposals.some(item => item.operation.type === "graph-type") ||
      [...input.remove, ...input.proposals.map(item => item.operation.ref)].some(ref => byRef.get(ref)?.operation.type === "graph-type"))
    requireEditor(who);
  const undecided = (row: OperationRow) => ["pending", "awaiting_review", "removed"].includes(row.state);
  const refs = new Set(input.proposals.map(item => item.operation.ref));
  if (refs.size !== input.proposals.length || new Set(input.remove).size !== input.remove.length)
    fail("Each proposal and removal must have a distinct ref");
  for (const ref of [...refs, ...input.remove]) {
    const row = byRef.get(ref);
    if (row && !undecided(row)) fail(`${ref} is already decided`, 409);
    if (input.remove.includes(ref) && (!row || row.state === "removed" || refs.has(ref)))
      fail(`${ref} must name an undecided proposal and cannot also be replaced`, 409);
  }
  let position = Math.max(-1, ...existing.map(row => row.position)) + 1;
  const written = input.proposals.map((item): OperationRow => ({
    batchId, ref: item.operation.ref, position: byRef.get(item.operation.ref)?.position ?? position++,
    operation: item.operation as unknown as Record<string, unknown>, evidence: item.evidence,
    confidence: item.confidence ?? null, reason: item.reason ?? null,
    state,
    decidedBy: null, decision: null, recordId: null, recordRevision: null,
  }));
  for (const row of written) {
    const prior = byRef.get(row.ref);
    if (prior && changesRequested(prior) &&
        canonicalActionValue([row.operation, row.evidence, row.confidence, row.reason]) ===
        canonicalActionValue([prior.operation, prior.evidence, prior.confidence, prior.reason]))
      fail(`${row.ref} has requested changes; update its proposal or withdraw it`, 409);
  }
  const next = new Map(byRef);
  for (const ref of input.remove) next.set(ref, { ...byRef.get(ref)!, state: "removed" });
  for (const row of written) next.set(row.ref, row);
  const rows = live([...next.values()]).sort((a, b) => a.position - b.position);
  if (rows.length > batchOperationCap) fail(`A batch holds at most ${batchOperationCap} operations`, 413);
  return { existing, written, rows };
}

export function batchRowsUnchanged(batch: BatchRow, existing: OperationRow[]) {
  // Compare raw JSON text in SQLite using one bound snapshot, below D1's parameter limit.
  const snapshot = JSON.stringify(existing.map(row => ({ ...row, operation: JSON.stringify(row.operation), evidence: JSON.stringify(row.evidence) })));
  return sql`exists (select 1 from graph_batches where id=${batch.id} and state=${batch.state}
    and submittedVersion=${batch.submittedVersion} and updatedAt=${batch.updatedAt} and commits=${batch.commits}
    and reviewJobId is ${batch.reviewJobId} and anchors is ${batch.anchors ? JSON.stringify(batch.anchors) : null})
    and (select count(*) from graph_batch_operations where batchId=${batch.id})=${existing.length}
    and not exists (select 1 from json_each(${snapshot}) e left join graph_batch_operations r
      on r.batchId=${batch.id} and r.ref=json_extract(e.value,'$.ref') where r.ref is null
      or r.state is not json_extract(e.value,'$.state') or r.operation is not json_extract(e.value,'$.operation')
      or r.evidence is not json_extract(e.value,'$.evidence') or r.position is not json_extract(e.value,'$.position')
      or r.confidence is not json_extract(e.value,'$.confidence') or r.reason is not json_extract(e.value,'$.reason')
      or r.decision is not json_extract(e.value,'$.decision') or r.decidedBy is not json_extract(e.value,'$.decidedBy')
      or r.recordId is not json_extract(e.value,'$.recordId') or r.recordRevision is not json_extract(e.value,'$.recordRevision'))`;
}

function checkObservedVersion(batch: BatchRow, expected: number | undefined, required = false) {
  if (expected === undefined && required)
    fail("Pass expectedVersion from the current batch", 409);
  if (expected !== undefined && expected !== batch.submittedVersion)
    fail("Proposal version changed; reload the batch", 409);
}

function changesRequested(row: OperationRow) {
  return row.decision !== null && JSON.parse(row.decision)?.verdict === "request_changes";
}

function writeProposals(batchId: string, written: OperationRow[], remove: string[]) {
  const statements: SQL[] = [];
  if (remove.length) statements.push(sql`UPDATE graph_batch_operations SET state='removed' WHERE batchId=${batchId} AND ref IN (SELECT value FROM json_each(${JSON.stringify(remove)}))`);
  for (const row of written) statements.push(sql`INSERT INTO graph_batch_operations(batchId,ref,position,operation,evidence,confidence,reason,state)
    VALUES(${row.batchId},${row.ref},${row.position},${JSON.stringify(row.operation)},${JSON.stringify(row.evidence)},${row.confidence},${row.reason},${row.state})
    ON CONFLICT(batchId,ref) DO UPDATE SET position=excluded.position,operation=excluded.operation,evidence=excluded.evidence,confidence=excluded.confidence,reason=excluded.reason,state=excluded.state,decision=NULL,decidedBy=NULL`);
  return statements;
}

/** The legacy mutation edits drafts in place and submits amendments through the shared writer. */
export async function reviseBatch(db: Database, who: AppIdentity, actor: AppActor, origin: AppActor, input: z.infer<typeof batchReviseInput>) {
  requireEntityWriter(who);
  const batch = await loadBatch(db, input.batchId);
  checkObservedVersion(batch, input.expectedVersion);
  if (batch.state === "awaiting_review") {
    await writeBatchSubmission(db, who, actor, origin, {
      ...input, expectedVersion: batch.submittedVersion,
    }, batch);
  } else {
    if (batch.state !== "open") fail("Only an open or submitted batch can be edited", 409);
    if (batch.policy.kind !== "member" && !(actor.kind === "app" && batch.openedVia === actorRef(actor)))
      requireMemberReview(who, actor, origin);
    if (batch.expiresAt <= Date.now()) fail("The batch has expired", 409);
    const { existing, written } = await proposedRows(db, who, batch.id, batch, input, "pending");
    await writeDraft(db, who, batch, existing, writeProposals(batch.id, written, input.remove));
  }
  return getBatch(db, who, { batchId: batch.id });
}

const submissionReceipt = z.object({
  id: z.uuid(),
  title: z.string(),
  submittedVersion: z.number(),
  state: z.string(),
  counts: z.record(z.string(), z.number()),
  reviewRefs: z.array(z.string()),
  reviewRun: z.object({ runId: z.uuid(), state: z.literal("pending") }).nullable(),
});
export type BatchSubmissionReceipt = z.infer<typeof submissionReceipt>;

function submissionStatement(batchId: string, version: number, rows: OperationRow[], userId: string, actor: AppActor, now: number) {
  return sql`INSERT INTO graph_batch_submissions (batchId,version,at,author,via,proposals)
    VALUES(${batchId},${version},${now},${userId},${actorRef(actor)},${JSON.stringify(proposalSnapshot(rows))})`;
}

type BatchSubmissionInput = z.infer<typeof mutateBatchSubmissionInput>;

export async function mutateBatchSubmission(db: Database, who: AppIdentity, actor: AppActor, origin: AppActor, input: BatchSubmissionInput) {
  requireEntityWriter(who);
  // Two digests keep this receipt outside graph.apply's 128-character key space.
  const caller = JSON.stringify([actorRef(actor), actorRef(origin)]);
  const requestKey = `batch-submission:${await sha256Hex(caller)}:${await sha256Hex(input.requestKey)}`;
  const hash = await sha256Hex(canonicalActionValue(input));
  async function replay() {
    const [saved] = await db.select().from(graphChanges).where(and(eq(graphChanges.userId, who.userId), eq(graphChanges.requestKey, requestKey)));
    if (!saved) return;
    if (saved.hash !== hash) fail("This requestKey already has a different batch submission", 409);
    return submissionReceipt.parse(saved.receipt);
  }
  const saved = await replay();
  if (saved) return saved;
  try {
    if (input.deleteBatch) return await discardOpenBatch(db, who, actor, origin, input, requestKey, hash);
    const [batch] = input.batchId ? await db.select().from(graphBatches).where(eq(graphBatches.id, input.batchId)) : [];
    return await writeBatchSubmission(db, who, actor, origin, input, batch, { requestKey, hash });
  } catch (error) {
    const completed = await replay();
    if (completed) return completed;
    throw error;
  }
}

async function discardOpenBatch(db: Database, who: AppIdentity, actor: AppActor, origin: AppActor, input: BatchSubmissionInput, requestKey: string, hash: string): Promise<BatchSubmissionReceipt> {
  const { batchId, expectedVersion, title, purpose, source, anchors, summary, proposals, remove } = input;
  if (!batchId || title !== undefined || purpose !== undefined || source !== undefined || anchors !== undefined ||
      summary !== undefined || proposals.length || remove.length) fail("Deleting a draft takes only batchId, expectedVersion and requestKey");
  const batch = await loadBatch(db, batchId);
  if (batch.state !== "open" || batch.commits || batch.submittedVersion) fail("Only an open, never-submitted draft can be deleted", 409);
  const sameActor = batch.openedVia === actorRef(actor) && actorRef(actor) === actorRef(origin);
  const opener = sameActor && (batch.policy.kind === "member" ? batch.openedBy === who.userId : actor.kind === "app");
  if (!opener) {
    if (batch.policy.kind !== "member") fail("Only the opening app can delete a policy draft", 403);
    requireMemberReview(who, actor, origin);
  }
  checkObservedVersion(batch, expectedVersion, true);
  const rows = await loadOperations(db, batchId);
  const counts: Record<string, number> = {};
  for (const row of live(rows)) counts[row.state] = (counts[row.state] ?? 0) + 1;
  const receipt = { id: batchId, title: batch.title, submittedVersion: batch.submittedVersion,
    state: "discarded", counts, reviewRefs: [], reviewRun: null };
  const now = Date.now();
  await guardedBatch(db, [
    submissionGuard(who, requestKey, hash, batchRowsUnchanged(batch, rows), receipt),
    sql`UPDATE onto_review_jobs SET state='superseded',leaseId=NULL,leaseUntil=NULL
      WHERE id=${batch.reviewJobId} AND batchId=${batchId} AND state IN ('pending','running')`,
    sql`UPDATE graph_batches SET state='discarded',closedAt=${now},updatedAt=${now},reviewBy=NULL,reviewJobId=NULL WHERE id=${batchId}`,
  ], "Batch changed; reload before deleting");
  return receipt;
}

function submissionGuard(who: AppIdentity, key: string, hash: string, unchanged: SQL, receipt: BatchSubmissionReceipt) {
  const attempt = crypto.randomUUID();
  return sql`INSERT INTO graph_changes(userId,requestKey,hash,attempt,receipt)
    VALUES(${who.userId},${key},${hash},CASE WHEN ${unchanged} THEN ${attempt} ELSE NULL END,${JSON.stringify(receipt)})`;
}

async function writeBatchSubmission(db: Database, who: AppIdentity, actor: AppActor, origin: AppActor,
  input: Omit<BatchSubmissionInput, "requestKey">, batch?: BatchRow,
  replay?: { requestKey: string; hash: string }): Promise<BatchSubmissionReceipt> {
  if (batch) {
    checkObservedVersion(batch, input.expectedVersion, true);
    if (batch.state !== "open" && batch.state !== "awaiting_review") fail("Only an open or submitted batch can be edited", 409);
    if (batch.policy.kind !== "member") {
      if (batch.state === "open") fail("Submit open policy batches with SubmitBatch", 409);
      if (!(actor.kind === "app" && batch.openedVia === actorRef(actor))) requireMemberReview(who, actor, origin);
    }
    if (input.title !== undefined || input.purpose !== undefined || input.source !== undefined || input.anchors !== undefined)
      fail("Title, purpose, source and anchors apply when creating a batch");
    if (batch.state === "awaiting_review" && !input.proposals.length && !input.remove.length)
      fail("Name proposals to amend or withdraw");
  } else {
    if (input.expectedVersion !== undefined && input.expectedVersion !== 0) fail("Batch not found", 404);
    if (!input.title || !input.proposals.length || input.remove.length) fail("A new batch needs a title and proposals");
  }

  const batchId = batch?.id ?? input.batchId ?? crypto.randomUUID();
  const graph = await readGraph(db, who);
  const root = !batch && input.anchors === undefined ? await rootNode(db, who) : null;
  const anchors = batch ? batch.anchors : root ? [root] : input.anchors?.length ? await anchorIds(db, who, input.anchors) : null;
  const { existing, written, rows } = await proposedRows(db, who, batchId, batch, input, "awaiting_review");
  const policy = batch?.policy ?? { kind: "member" };
  const validation = await validateRows(db, who, { id: batchId, policy, anchors }, rows);
  if (!validation.valid) fail(`Fix the batch before submitting it: ${validation.error}`, 409);
  const now = Date.now();
  if (batch?.state === "open" && batch.expiresAt <= now) fail("The batch has expired", 409);
  const version = (batch?.submittedVersion ?? 0) + 1;
  const nextRows = rows.map(row => row.state === "pending" ? { ...row, state: "awaiting_review" } : row);
  const counts: Record<string, number> = {};
  for (const row of nextRows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  const reviewRefs = nextRows.filter(row => row.state === "awaiting_review").map(row => row.ref);
  if (!reviewRefs.length && batch?.state !== "awaiting_review") fail("A submission needs at least one pending proposal");
  const state = reviewRefs.length ? "awaiting_review" : counts.rejected && !counts.committed ? "rejected" : "committed";
  const contentDigest = await batchContentDigest(nextRows);
  const reused = batch ? await reusableDraftReview(db, batch, contentDigest) : undefined;
  const jobId = reused?.id ?? (reviewRefs.length ? crypto.randomUUID() : null);
  const runId = reused ? (reused.state === "complete" ? null : reused.runId) : jobId ? crypto.randomUUID() : null;
  const reviewRun = runId ? { runId, state: "pending" as const } : null;
  const title = batch?.title ?? input.title!;
  const receipt = { id: batchId, title, submittedVersion: version, state, counts, reviewRefs, reviewRun };
  const summary = { ...summarize(nextRows, new Map(graph.types.map(type => [type.id, type.name]))),
    text: input.summary ?? (batch?.summary ? JSON.parse(batch.summary).text : null) };
  const unchanged = batch ? batchRowsUnchanged(batch, existing)
    : sql`not exists (select 1 from graph_batches where id=${batchId})`;
  const editedRefs = new Set([...written.map(row => row.ref), ...input.remove]);
  const corrected = existing.some(row => editedRefs.has(row.ref) && changesRequested(row));
  const reviewBy = jobId ? corrected ? reviewDeadline(batchPolicy.parse(policy), now) : batch?.reviewBy ?? null : null;
  const key = replay?.requestKey ?? `amend:${crypto.randomUUID()}`;
  const statements = [submissionGuard(who, key, replay?.hash ?? "amend", unchanged, receipt)];
  if (!batch) {
    statements.push(sql`INSERT INTO graph_batches(id,title,purpose,source,policy,state,openedBy,openedVia,createdAt,updatedAt,expiresAt,anchors)
      VALUES(${batchId},${title},${input.purpose ?? ""},${input.source ? JSON.stringify(input.source) : null},${JSON.stringify(policy)},'open',${who.userId},${actorRef(actor)},${now},${now},${now + batchExpiryMs},${anchors ? JSON.stringify(anchors) : null})`);
  }
  statements.push(...writeProposals(batchId, written, input.remove));
  if (batch?.state === "awaiting_review" && batch.submittedVersion === 0) {
    statements.push(sql`INSERT INTO graph_batch_submissions(batchId,version,at,author,via,proposals)
      VALUES(${batchId},0,${now},'','',${JSON.stringify(proposalSnapshot(existing))})`);
  }
  statements.push(
    submissionStatement(batchId, version, nextRows, who.userId, actor, now),
    sql`UPDATE graph_batch_operations SET state='awaiting_review' WHERE batchId=${batchId} AND state='pending'`,
    sql`UPDATE graph_batches SET submittedVersion=${version},state=${state},summary=${JSON.stringify(summary)},
      reviewBy=${reviewBy},review=CASE WHEN ${Boolean(reused)} THEN review ELSE NULL END,
      reviewJobId=${jobId},updatedAt=${now},closedAt=${jobId ? null : now} WHERE id=${batchId}`,
  );
  if (jobId && !reused) statements.push(sql`INSERT INTO onto_review_jobs(id,batchId,contentDigest,state,nextAttemptAt,createdAt,runId)
    VALUES(${jobId},${batchId},${contentDigest},'pending',${now},${now},${runId})`);
  if (!replay) statements.push(sql`DELETE FROM graph_changes WHERE userId=${who.userId} AND requestKey=${key}`);
  await guardedGraphBatch(db, who, graph, statements, "Batch or graph changed; reload before submitting");
  if (reused) await approveCompletedDraftReview(db, who, batchId, reused.id);
  return receipt;
}

/** Member approval commits now; rejection also rejects what depends on a rejected record. */
export async function reviewBatch(db: Database, who: AppIdentity, actor: AppActor, origin: AppActor, input: z.infer<typeof batchReviewInput>) {
  requireMemberReview(who, actor, origin);
  const batch = await loadBatch(db, input.batchId);
  if (batch.state !== "awaiting_review") fail("Only a submitted batch waiting for review can be decided", 409);
  checkObservedVersion(batch, input.expectedVersion, input.verdict === "request_changes");
  const rows = live(await loadOperations(db, batch.id));
  const waiting = rows.filter((row) => row.state === "awaiting_review");
  const chosen = new Set((input.refs ?? waiting.map((row) => row.ref)).filter((r) => waiting.some((row) => row.ref === r)));
  if (!chosen.size) fail("No waiting operations match", 409);
  const at = Date.now();
  const decision = memberDecision(who, actor, { submittedVersion: batch.submittedVersion, verdict: input.verdict, comment: input.comment ?? null, at });
  if (input.verdict === "request_changes") {
    if (!input.comment?.trim()) fail("Explain what the submitter should change");
    const refs = [...chosen];
    const guard = `feedback:${crypto.randomUUID()}`;
    await guardedBatch(db, [
      sql`INSERT INTO graph_changes(userId,requestKey,hash,attempt,receipt)
        VALUES(${who.userId},${guard},'review',CASE WHEN ${reviewedRowsUnchanged(batch, waiting.filter(row => chosen.has(row.ref)))} THEN ${guard} ELSE NULL END,'{}')`,
      sql`UPDATE graph_batch_operations SET decidedBy=${who.userId},decision=${JSON.stringify(decision)}
        WHERE batchId=${batch.id} AND ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))`,
      sql`INSERT INTO graph_batch_change_requests (id,batchId,refs,decision)
        VALUES(${guard},${batch.id},${JSON.stringify(refs)},${JSON.stringify(decision)})`,
      sql`UPDATE graph_batches SET updatedAt=${at} WHERE id=${batch.id}`,
      sql`DELETE FROM graph_changes WHERE userId=${who.userId} AND requestKey=${guard}`,
    ], "Batch changed; reload before requesting changes");
    return getBatch(db, who, { batchId: batch.id });
  }
  if (input.verdict === "reject") {
    const rejected = withDependents(rows, waiting, chosen);
    const graph = await readGraph(db, who), guard = `reject:${crypto.randomUUID()}`;
    await guardedGraphBatch(db, who, graph, [
      sql`INSERT INTO graph_changes(userId,requestKey,hash,attempt,receipt) VALUES(${who.userId},${guard},'review',CASE WHEN ${reviewedRowsUnchanged(batch, rows)} THEN ${guard} ELSE NULL END,'{}')`,
      sql`UPDATE graph_batch_operations SET state='rejected',decidedBy=${who.userId},decision=${JSON.stringify(decision)} WHERE batchId=${batch.id} AND ref IN (SELECT value FROM json_each(${JSON.stringify([...rejected])}))`,
      sql`DELETE FROM graph_changes WHERE userId=${who.userId} AND requestKey=${guard}`,
    ], "Batch changed; reload before reviewing");
  } else await commitOperations(db, who, batch, rows, withDependencies(rows, waiting, chosen), () => decision);
  await settle(db, batch.id);
  return getBatch(db, who, { batchId: batch.id });
}

/** What the steward's approval needs from its review. */
type StewardReview = {
  complete: boolean; runId: string | null; prompt: { digest: string };
  findings: { ref: string | null; refs?: string[]; severity: string; rule: string }[];
};
/** What the steward decided after its review: how many operations it approved, and the
 * refs it left for a member with why. Saved on the review. */
export type StewardDecision = { approved: number; held: { ref: string; reason: string }[]; at: number };

/** The ontology steward approves what its own review found clean (docs/batch-review.md,
 * "Steward approval"). A finding of `error` or `warning` severity, a question on the batch,
 * or anything depending on them waits for a member; so does every operation when the review
 * failed, read the batch only in part, or flagged the batch as a whole. A batch-level
 * finding or a question without refs holds everything. Approval is recorded as the
 * steward's decision citing its review run, never as a member's. */
export async function stewardApprove(db: Database, who: AppIdentity, batchId: string, jobId: string, review: StewardReview): Promise<StewardDecision | null> {
  const batch = await loadBatch(db, batchId);
  if (batch.state !== "awaiting_review" || batch.reviewJobId !== jobId) return null;
  const rows = live(await loadOperations(db, batch.id));
  const waiting = rows.filter((row) => row.state === "awaiting_review");
  if (!waiting.length) return null;
  // The first reason that holds an operation is the one a member sees.
  const reasons = new Map<string, string>();
  const hold = (ref: string, reason: string) => { if (!reasons.has(ref)) reasons.set(ref, reason); };
  const holdAll = (reason: string) => { for (const row of waiting) hold(row.ref, reason); };
  for (const row of waiting.filter(changesRequested)) hold(row.ref, "changes were requested");
  if (!review.complete) holdAll("the review read only part of the batch");
  for (const item of review.findings.filter((finding) => finding.severity === "error" || finding.severity === "warning")) {
    const refs = [...(item.ref ? [item.ref] : []), ...(item.refs ?? [])];
    if (!refs.length) holdAll(`${item.rule} on the whole batch`);
    for (const ref of refs) hold(ref, item.rule);
  }
  // An answered question no longer holds anything: the member has settled it.
  for (const question of (batch.questions ?? []).filter((item) => !item.answer)) {
    if (!question.refs.length) holdAll(`question ${question.key}`);
    for (const ref of question.refs) hold(ref, `question ${question.key}`);
  }
  // Check current candidates as well: another batch may have added an Organization during inference.
  const graph = await readGraph(db, who);
  for (const duplicate of organizationDuplicates(graph, waiting)) hold(duplicate.ref, duplicate.message);
  const flagged = new Set(waiting.filter((row) => reasons.has(row.ref)).map((row) => row.ref));
  for (const ref of withDependents(rows, waiting, flagged)) hold(ref, "depends on a held proposal");
  const clean = new Set(waiting.filter((row) => !reasons.has(row.ref)).map((row) => row.ref));
  const chosen = anchoredSelection(graph, rows, closeSelection(rows, clean), batch.anchors);
  for (const row of waiting) if (!chosen.has(row.ref)) hold(row.ref, "does not connect to an anchor without a held proposal");
  const at = Date.now();
  const approval = (): Approval => ({ kind: "steward", runId: review.runId, prompt: review.prompt.digest, reason: "clean review", at });
  await commitByPolicy(db, who, batch, rows, chosen, approval);
  await settle(db, batch.id);
  // Report what actually happened: a part that no longer applied, or that a member decided
  // meanwhile, is not counted as the steward's.
  const after = new Map(live(await loadOperations(db, batch.id)).map((row) => [row.ref, row]));
  const approved = waiting.filter((row) => after.get(row.ref)?.state === "committed" && (JSON.parse(after.get(row.ref)?.decision ?? "null") as { kind?: string } | null)?.kind === "steward").length;
  const held = waiting.filter((row) => after.get(row.ref)?.state === "awaiting_review")
    .map((row) => ({ ref: row.ref, reason: reasons.get(row.ref) ?? "the approved part would not apply" }));
  return { approved, held, at };
}

/** Run the steward's approval for a finished (complete-state) review and save its decision on that review. */
export async function approveAfterReview(db: Database, who: AppIdentity, batchId: string, jobId: string, review: StewardReview) {
  // An admin can keep every decision with members (Settings, "After the steward reviews").
  if ((await readSettings(db)).stewardApproval !== "approve") return null;
  const decision = await stewardApprove(db, who, batchId, jobId, review);
  if (decision) await db.update(graphBatches).set({ review: { ...review, decision } as never })
    .where(and(eq(graphBatches.id, batchId), eq(graphBatches.reviewJobId, jobId)));
  return decision;
}

/** Rejecting an operation rejects the waiting operations that depend on it. */
function withDependents(rows: OperationRow[], waiting: OperationRow[], chosen: Set<string>) {
  const createdBy = createdIds(rows);
  const result = new Set(chosen);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of waiting) {
      if (result.has(row.ref) || ![...dependencies(row, createdBy)].some((dep) => result.has(dep))) continue;
      result.add(row.ref);
      grew = true;
    }
  }
  return result;
}

/** Approving an operation approves the waiting operations it depends on. */
function withDependencies(rows: OperationRow[], waiting: OperationRow[], chosen: Set<string>) {
  const createdBy = createdIds(rows);
  const waitingRefs = new Set(waiting.map((row) => row.ref));
  const result = new Set(chosen);
  const queue = [...chosen];
  while (queue.length) {
    const ref = queue.pop();
    const row = waiting.find((item) => item.ref === ref);
    if (!row) continue;
    for (const dep of dependencies(row, createdBy))
      if (waitingRefs.has(dep) && !result.has(dep)) { result.add(dep); queue.push(dep); }
  }
  return result;
}

/** Expire stale open batches and seal batches whose review window has passed. */
export async function sealDueBatches(db: Database, who: AppIdentity, now = Date.now()) {
  if (!who.canEdit && !who.entityWriter) return { sealed: 0, expired: 0 };
  const expired = await db.update(graphBatches).set({ state: "discarded", closedAt: now, updatedAt: now })
    .where(and(eq(graphBatches.state, "open"), sql`${graphBatches.expiresAt} <= ${now}`)).returning({ id: graphBatches.id });
  const due = await db.select().from(graphBatches)
    .where(and(eq(graphBatches.state, "awaiting_review"), sql`${graphBatches.reviewBy} IS NOT NULL AND ${graphBatches.reviewBy} <= ${now}`));
  let sealed = 0;
  for (const batch of due) {
    const policy = batchPolicy.parse(batch.policy);
    const rows = live(await loadOperations(db, batch.id));
    const waiting = rows.filter((row) => row.state === "awaiting_review");
    const eligible = new Set(waiting.filter(row => !changesRequested(row)).map(row => row.ref));
    if (waiting.some(isOrganizationCreate)) {
      for (const duplicate of organizationDuplicates(await readGraph(db, who), waiting)) eligible.delete(duplicate.ref);
    }
    const chosen = closeSelection(rows, eligible);
    const committed = await commitByPolicy(db, who, batch, rows, chosen, policyApproval(policy, "review-window"));
    sealed += committed;
    // A failed seal (a concurrent edit, or a subset that no longer validates)
    // keeps its deadline so the next seal retries; otherwise the window closes.
    if (committed || !chosen.size) {
      await db.update(graphBatches).set({ reviewBy: null, updatedAt: Date.now() }).where(and(
        eq(graphBatches.id, batch.id), eq(graphBatches.submittedVersion, batch.submittedVersion),
        sql`${graphBatches.reviewBy} IS ${batch.reviewBy}`,
      ));
    }
    await settle(db, batch.id);
  }
  return { sealed, expired: expired.length };
}

function batchView(batch: BatchRow) {
  return {
    submittedVersion: batch.submittedVersion, id: batch.id, title: batch.title, purpose: batch.purpose, source: batch.source, policy: batch.policy,
    state: batch.state, summary: batch.summary ? JSON.parse(batch.summary) : null,
    openedBy: batch.openedBy, openedVia: batch.openedVia, reviewBy: batch.reviewBy,
    createdAt: batch.createdAt, updatedAt: batch.updatedAt, expiresAt: batch.expiresAt, closedAt: batch.closedAt,
    review: batch.review ?? null, anchors: batch.anchors ?? null, questions: batch.questions ?? [],
  };
}

export async function getBatch(db: Database, who: AppIdentity, input: z.infer<typeof batchIdInput>) {
  const batch = await loadBatch(db, input.batchId);
  const rows = live(await loadOperations(db, batch.id));
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  return {
    batch: batchView(batch),
    counts,
    operations: rows.map((row) => ({
      ref: row.ref, position: row.position, operation: row.operation, evidence: row.evidence,
      confidence: row.confidence, reason: row.reason, state: row.state,
      decision: row.decision ? JSON.parse(row.decision) : null, recordId: row.recordId, recordRevision: row.recordRevision,
    })),
    canReview: who.canEdit && !who.entityWriter && !isResidentPrincipal(who.userId),
  };
}

export async function changeRequests(db: Database, batchId: string) {
  return db.select({ refs: batchChangeRequests.refs, decision: batchChangeRequests.decision })
    .from(batchChangeRequests).where(eq(batchChangeRequests.batchId, batchId))
    .orderBy(sql`json_extract(${batchChangeRequests.decision}, '$.at')`, asc(batchChangeRequests.id));
}

export async function listBatches(db: Database, _who: AppIdentity, input: z.infer<typeof batchListInput>) {
  const batches = await db.select().from(graphBatches)
    .where(input.state ? eq(graphBatches.state, input.state) : undefined)
    .orderBy(desc(graphBatches.updatedAt)).limit(input.limit);
  const counts = batches.length ? await db.select({ batchId: graphBatchOperations.batchId, state: graphBatchOperations.state, n: sql<number>`count(*)` })
    .from(graphBatchOperations).where(inArray(graphBatchOperations.batchId, batches.map((b) => b.id)))
    .groupBy(graphBatchOperations.batchId, graphBatchOperations.state) : [];
  return {
    batches: batches.map((batch) => ({
      ...batchView(batch),
      counts: Object.fromEntries(counts.filter((c) => c.batchId === batch.id && c.state !== "removed").map((c) => [c.state, Number(c.n)])),
    })),
  };
}

export async function recordHistory(db: Database, _who: AppIdentity, input: z.infer<typeof recordHistoryInput>) {
  const rows = await db.select().from(graphRevisions).where(eq(graphRevisions.recordId, input.id)).orderBy(desc(graphRevisions.revision)).limit(100);
  const batchIds = [...new Set(rows.flatMap((row) => (row.batchId ? [row.batchId] : [])))];
  const batches = batchIds.length ? await db.select({ id: graphBatches.id, title: graphBatches.title }).from(graphBatches).where(inArray(graphBatches.id, batchIds)) : [];
  const titles = new Map(batches.map((b) => [b.id, b.title]));
  return {
    revisions: rows.map((row) => ({
      kind: row.kind, revision: row.revision, batchId: row.batchId, batchTitle: row.batchId ? titles.get(row.batchId) ?? null : null,
      ref: row.ref, proposedBy: row.proposedBy, approval: row.approval, evidence: row.evidence, createdAt: row.createdAt,
      created: row.prior === null,
    })),
    /** Revisions before batches were installed have no history row. */
    complete: rows.length > 0 && rows[rows.length - 1].prior === null,
  };
}

/** The steward's review of a batch while it is queued or running: the reserved workflow run
 * an agent can wait on, and the job's state. Null once the review has finished. */
export async function pendingReview(db: Database, batchId: string) {
  const [row] = await db.select({ id: ontoReviewJobs.id, state: ontoReviewJobs.state, runId: ontoReviewJobs.runId })
    .from(graphBatches).innerJoin(ontoReviewJobs, eq(ontoReviewJobs.id, graphBatches.reviewJobId)).where(and(eq(graphBatches.id, batchId), eq(graphBatches.state, "awaiting_review")));
  return row && (row.state === "pending" || row.state === "running") && row.runId ? { runId: row.runId, state: row.state } : null;
}

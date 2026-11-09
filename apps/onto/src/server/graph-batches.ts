import {
  type AppActor,
  type AppIdentity,
  isResidentPrincipal,
  requireEditor,
  requireEntityWriter,
  sha256Hex,
} from "@ai-outfitter/app-sdk/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { readGraph } from "./graph";
import { handleIndex, resolveHandle } from "../lib/record-handles";
import {
  applyGraphChanges,
  checkGraphChanges,
  graphChangeInput,
} from "./graph-changes";
import { graphBatches, graphBatchOperations, graphRevisions, ontoReviewJobs } from "./schema";

// Wiki change batches (docs/plans/wiki-change-batches.md). A batch stages
// graph.apply operations over many calls; nothing is visible to graph reads
// until an operation commits through applyGraphChanges, which also writes the
// history row. Policies decide what commits without a member: a confidence
// threshold, a review window that seals the rest, or a first discovery run.

import { batchOperationCap, batchExpiryMs, batchPolicy, batchOpenInput, batchAddInput, batchRemoveInput, batchIdInput, batchListInput, batchSubmitInput, batchReviewInput, recordHistoryInput, type BatchPolicy } from "@ai-outfitter/onto/contracts";
export { batchOperationCap, batchExpiryMs, policyThresholdFloor, batchPolicy, batchSource, batchOpenInput, batchAddInput, batchRemoveInput, batchIdInput, batchListInput, batchSubmitInput, batchReviewInput, recordHistoryInput, type BatchPolicy } from "@ai-outfitter/onto/contracts";
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

async function loadBatch(db: Database, id: string) {
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
  const anchors = input.anchors?.length ? await anchorIds(db, who, input.anchors) : null;
  const now = Date.now();
  const id = crypto.randomUUID();
  await db.insert(graphBatches).values({
    id, title: input.title, purpose: input.purpose, source: input.source ?? null, policy: input.policy, anchors,
    state: "open", openedBy: who.userId, openedVia: actorRef(actor),
    createdAt: now, updatedAt: now, expiresAt: now + batchExpiryMs,
  });
  return getBatch(db, who, { batchId: id });
}

/** The saved nodes a batch's anchors name. */
async function anchorIds(db: Database, who: AppIdentity, anchors: string[]) {
  const graph = await readGraph(db, who);
  const index = handleIndex(graph);
  return anchors.map((anchor) => {
    const id = resolveHandle(index, "graph-node", anchor);
    if (!graph.nodes.some((node) => node.id === id && !node.archived)) fail(`Unknown anchor ${anchor}`);
    return id;
  });
}

/** Every node the batch creates must reach an anchor along saved or staged edges, in
 * either direction and through any number of nodes. Returns the titles that do not. */
function unanchored(graph: Awaited<ReturnType<typeof readGraph>>, rows: OperationRow[], anchors: string[]) {
  const index = handleIndex(graph);
  const op = (row: OperationRow) => row.operation as { type?: string; operation?: string; attributes?: Record<string, unknown> };
  const idOf = (row: OperationRow) => String(op(row).attributes?.id ?? row.ref);
  const refs = new Map(rows.map((row) => [row.ref, idOf(row)]));
  const node = (value: unknown) => refs.get(String(value)) ?? index["graph-node"].get(String(value)) ?? String(value);
  const links = new Map<string, string[]>();
  const link = (a: string, b: string) => { links.set(a, [...(links.get(a) ?? []), b]); links.set(b, [...(links.get(b) ?? []), a]); };
  for (const edge of graph.edges) if (!edge.archived) link(edge.fromId, edge.toId);
  for (const row of rows) if (op(row).type === "graph-edge" && !op(row).attributes?.archived)
    link(node(op(row).attributes?.fromId), node(op(row).attributes?.toId));
  const reached = new Set(anchors), queue = [...anchors];
  while (queue.length) for (const next of links.get(queue.pop()!) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next); }
  return rows.filter((row) => op(row).type === "graph-node" && op(row).operation === "create" && !reached.has(idOf(row)))
    .map((row) => String(op(row).attributes?.title ?? row.ref));
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
function requireOpen(batch: BatchRow, actor: AppActor) {
  if (batch.state !== "open") fail("The batch is no longer open", 409);
  if (batch.expiresAt <= Date.now()) fail("The batch has expired", 409);
  if ((batch.policy as { kind?: string }).kind !== "member" && (actor.kind !== "app" || batch.openedVia !== actorRef(actor)))
    fail("This batch commits by policy; stage changes in a batch a member reviews", 403);
}

/** Rows for proposals not yet in the batch. Retrying the same proposal is a no-op;
 * reusing a ref for another one is a conflict. */
function newRows(batchId: string, existing: OperationRow[], proposals: z.infer<typeof batchAddInput>["proposals"]) {
  const byRef = new Map(existing.map((row) => [row.ref, row]));
  const added: OperationRow[] = [];
  let position = existing.length ? existing[existing.length - 1].position + 1 : 0;
  for (const item of proposals) {
    const saved = byRef.get(item.operation.ref);
    const operation = item.operation as unknown as Record<string, unknown>;
    const live = saved && saved.state !== "removed";
    if (live && JSON.stringify(saved.operation) === JSON.stringify(operation)) continue;
    if (live) fail(`Reference ${item.operation.ref} is already used in this batch`, 409);
    added.push({
      batchId, ref: item.operation.ref, position: position++, operation,
      evidence: item.evidence, confidence: item.confidence ?? null, reason: item.reason ?? null, state: "pending",
      decidedBy: null, decision: null, recordId: null, recordRevision: null,
    });
  }
  return added;
}

export async function addToBatch(db: Database, who: AppIdentity, actor: AppActor, input: z.infer<typeof batchAddInput>) {
  requireEntityWriter(who);
  if (input.proposals.some((item) => item.operation.type === "graph-type")) requireEditor(who);
  const batch = await loadBatch(db, input.batchId);
  requireOpen(batch, actor);
  const existing = await loadOperations(db, batch.id);
  const added = newRows(batch.id, existing, input.proposals);
  if (existing.filter((row) => row.state !== "removed").length + added.length > batchOperationCap)
    fail(`A batch holds at most ${batchOperationCap} operations`, 413);
  // One round trip; a row per statement stays under D1's bound-parameter limit.
  const inserts = added.map((row) => db.insert(graphBatchOperations).values(row).onConflictDoUpdate({
    target: [graphBatchOperations.batchId, graphBatchOperations.ref],
    set: { position: row.position, operation: row.operation, evidence: row.evidence, confidence: row.confidence, reason: row.reason, state: "pending" },
  }));
  if (inserts.length) await db.batch(inserts as [typeof inserts[number], ...typeof inserts]);
  await touch(db, batch.id, {});
  return { batchId: batch.id, added: added.length, operations: existing.length + added.length };
}

export async function removeFromBatch(db: Database, who: AppIdentity, actor: AppActor, input: z.infer<typeof batchRemoveInput>) {
  requireEntityWriter(who);
  const batch = await loadBatch(db, input.batchId);
  requireOpen(batch, actor);
  await db.update(graphBatchOperations).set({ state: "removed" })
    .where(and(eq(graphBatchOperations.batchId, batch.id), inArray(graphBatchOperations.ref, input.refs)));
  await touch(db, batch.id, {});
  return getBatch(db, who, { batchId: batch.id });
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
function resolveCommitted(row: OperationRow, committed: Map<string, string>): Operation {
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
  let commits = batch.commits;
  for (let start = 0; start < chosen.length; start += 100) {
    const chunk = chosen.slice(start, start + 100);
    const operations = chunk.map((row) => resolveCommitted(row, committed));
    commits++;
    // Keyed by the chunk's refs: two concurrent commits of the same operations
    // replay one receipt, and different operations never share a key.
    const requestKey = `batch:${batch.id}:${(await sha256Hex(chunk.map((row) => row.ref).join(","))).slice(0, 32)}`;
    // One approval describes the chunk in history; per-operation detail stays on the batch rows.
    const receipt = await applyGraphChanges(db, who, { requestKey, operations }, {
      batchId: batch.id,
      proposedBy: batch.openedBy,
      approval: approval(chunk[0]),
      evidence: Object.fromEntries(chunk.map((row) => [row.ref, row.evidence])),
    });
    for (const row of chunk) {
      const saved = receipt[row.ref];
      committed.set(row.ref, saved.id);
      await db.update(graphBatchOperations)
        .set({ state: "committed", recordId: saved.id, recordRevision: saved.revision, decision: JSON.stringify(approval(row)),
          // A policy decides by itself; whoever triggered the seal did not decide.
          decidedBy: approval(row).kind === "policy" ? null : who.userId })
        .where(and(eq(graphBatchOperations.batchId, batch.id), eq(graphBatchOperations.ref, row.ref)));
    }
    await touch(db, batch.id, { commits });
  }
  return chosen.length;
}

async function settle(db: Database, batchId: string) {
  const rows = live(await loadOperations(db, batchId));
  const waiting = rows.some((row) => row.state === "pending" || row.state === "awaiting_review");
  if (waiting) return;
  const state = rows.some((row) => row.state === "committed") || !rows.length ? "committed" : "rejected";
  await touch(db, batchId, { state, closedAt: Date.now(), reviewBy: null });
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
    const loose = batch.anchors?.length ? unanchored(graph, rows, batch.anchors) : [];
    if (loose.length) fail(`Connect these to an anchor before submitting: ${loose.slice(0, 20).join(", ")}`, 409);
  }
  const now = Date.now();
  const jobId = crypto.randomUUID();
  const contentDigest = await batchContentDigest(rows);
  // D1 batch executes these statements atomically: no submitted batch can lose its review work.
  await db.batch([
    db.update(graphBatchOperations).set({ state: "awaiting_review" })
      .where(and(eq(graphBatchOperations.batchId, batch.id), eq(graphBatchOperations.state, "pending"))),
    db.update(graphBatches).set({ state: "awaiting_review", summary: JSON.stringify(summary), reviewBy: reviewDeadline(policy, now), updatedAt: now, reviewJobId: jobId })
      .where(and(eq(graphBatches.id, batch.id), eq(graphBatches.state, "open"))),
    db.insert(ontoReviewJobs).values({ id: jobId, batchId: batch.id, contentDigest, state: "pending", nextAttemptAt: now, createdAt: now }),
  ]);
  const submitted = { ...batch, state: "awaiting_review", commits: batch.commits };
  const waiting = live(await loadOperations(db, batch.id));
  if (policy.kind === "first-run")
    await commitByPolicy(db, who, submitted, waiting, new Set(waiting.map((row) => row.ref)), policyApproval(policy, "first-run"));
  else if (policy.kind === "confidence") {
    const confident = new Set(waiting.filter((row) => (row.confidence ?? 0) >= policy.threshold).map((row) => row.ref));
    await commitByPolicy(db, who, submitted, waiting, closeSelection(waiting, confident), policyApproval(policy, "confidence"));
  }
  await settle(db, batch.id);
  return getBatch(db, who, { batchId: batch.id });
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

async function validateBatch(db: Database, who: AppIdentity, input: z.infer<typeof batchIdInput>) {
  const batch = await loadBatch(db, input.batchId);
  const rows = live(await loadOperations(db, batch.id));
  const committed = new Map(rows.filter((row) => row.state === "committed" && row.recordId).map((row) => [row.ref, row.recordId!]));
  const operations = rows.filter((row) => row.state !== "committed" && row.state !== "rejected").map((row) => resolveCommitted(row, committed));
  if (!operations.length) return { valid: true as const, error: null, operations: 0 };
  try {
    // The whole batch at once, so refs from earlier add calls resolve. Validation
    // writes nothing, so the 100-operation limit of a single apply does not apply.
    await checkGraphChanges(db, who, { requestKey: `validate:${batch.id}`, operations });
    return { valid: true as const, error: null, operations: operations.length };
  } catch (error) {
    if (!(error instanceof Response) || error.status >= 500) throw error;
    return { valid: false as const, error: (await error.text()).slice(0, 2000), operations: operations.length };
  }
}

/** Member approval commits now; rejection also rejects what depends on a rejected record. */
export async function reviewBatch(db: Database, who: AppIdentity, actor: AppActor, origin: AppActor, input: z.infer<typeof batchReviewInput>) {
  requireMemberReview(who, actor, origin);
  const batch = await loadBatch(db, input.batchId);
  if (batch.state !== "awaiting_review") fail("Only a submitted batch waiting for review can be decided", 409);
  const rows = live(await loadOperations(db, batch.id));
  const waiting = rows.filter((row) => row.state === "awaiting_review");
  const chosen = new Set((input.refs ?? waiting.map((row) => row.ref)).filter((r) => waiting.some((row) => row.ref === r)));
  if (!chosen.size) fail("No waiting operations match", 409);
  const decision = memberDecision(who, actor, { verdict: input.verdict, comment: input.comment ?? null, at: Date.now() });
  if (input.verdict === "reject") {
    const rejected = withDependents(rows, waiting, chosen);
    await db.update(graphBatchOperations).set({ state: "rejected", decidedBy: who.userId, decision: JSON.stringify(decision) })
      .where(and(eq(graphBatchOperations.batchId, batch.id), inArray(graphBatchOperations.ref, [...rejected])));
  } else await commitOperations(db, who, batch, rows, withDependencies(rows, waiting, chosen), () => decision);
  await settle(db, batch.id);
  return getBatch(db, who, { batchId: batch.id });
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
    const chosen = closeSelection(rows, new Set(waiting.map((row) => row.ref)));
    const committed = await commitByPolicy(db, who, batch, rows, chosen, policyApproval(policy, "review-window"));
    sealed += committed;
    // A failed seal (a concurrent edit, or a subset that no longer validates)
    // keeps its deadline so the next seal retries; otherwise the window closes.
    if (committed || !chosen.size) await touch(db, batch.id, { reviewBy: null });
    await settle(db, batch.id);
  }
  return { sealed, expired: expired.length };
}

function batchView(batch: BatchRow) {
  return {
    id: batch.id, title: batch.title, purpose: batch.purpose, source: batch.source, policy: batch.policy,
    state: batch.state, summary: batch.summary ? JSON.parse(batch.summary) : null,
    openedBy: batch.openedBy, openedVia: batch.openedVia, reviewBy: batch.reviewBy,
    createdAt: batch.createdAt, updatedAt: batch.updatedAt, expiresAt: batch.expiresAt, closedAt: batch.closedAt,
    review: batch.review ?? null, anchors: batch.anchors ?? null,
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

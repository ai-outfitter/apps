// The ontology steward's automatic review of a submitted change batch
// (agent/ontology-steward.md, "Review one batch"). Submitting a batch starts one
// batch-review workflow run: deterministic checks, then the steward prompt over
// the batch's operations and the records they touch. Its findings are saved on
// the batch with the run's ID; the run's logs are the audit trail, and a re-review
// is a new run. The review is advisory: it never approves, rejects, holds or
// commits anything, and the batch's policy decides exactly as it would without it
// (gating is a deferred governance control, docs/batch-review.md).
import { type EvidenceItem, evidenceList } from "@ai-outfitter/app-sdk/evidence";
import { type AppIdentity, sha256Hex } from "@ai-outfitter/app-sdk/server";
import { type WorkflowHost, workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import stewardPrompt from "../../agent/ontology-steward.md?raw";
import { core, type Graph } from "../lib/graph";
import { readGraph } from "./graph";
import { type Database, live, loadOperations, batchContentDigest } from "./graph-batches";
import { graphBatches, ontoReviewJobs } from "./schema";

export const reviewWorkflow = "batch-review";
export const reviewStep = "review";
export const promptPath = "apps/onto/agent/ontology-steward.md";
/** An abandoned final lease is terminal and must not remain running forever. */
export async function failExpiredReviewJobs(db: Database, now = Date.now()) {
  return db.update(ontoReviewJobs).set({state:"failed",leaseId:null,leaseUntil:null,error:"Review lease expired after maximum attempts"})
    .where(and(eq(ontoReviewJobs.state,"running"),lte(ontoReviewJobs.leaseUntil,now),sql`${ontoReviewJobs.attempts} >= ${maxAttempts}`)).returning();
}
/** Operations the steward reads in detail; a larger batch is reviewed in part. */
const operationLimit = 300;
/** Existing records shown around the batch, and relationships shown per record. */
const neighborLimit = 200;
const edgesPerNeighbor = 12;

export const finding = z.strictObject({
  /** The operation it is about, or null for the batch as a whole. */
  ref: z.string().max(80).nullable(),
  rule: z.string().min(1).max(64),
  severity: z.enum(["error", "warning", "note"]),
  message: z.string().min(1).max(1000),
  fix: z.string().max(1000).nullable(),
});
export type Finding = z.infer<typeof finding>;
const stewardAnswer = z.strictObject({
  summary: z.string().max(1000),
  findings: z.array(finding).max(100),
});
/** JSON Schema of the steward's answer, for inference.generate. */
const answerSchema = {
  type: "object", additionalProperties: false, required: ["summary", "findings"],
  properties: {
    summary: { type: "string", maxLength: 1000 },
    findings: {
      type: "array", maxItems: 100,
      items: {
        type: "object", additionalProperties: false, required: ["ref", "rule", "severity", "message", "fix"],
        properties: {
          ref: { type: ["string", "null"], maxLength: 80 },
          rule: { type: "string", maxLength: 64 },
          severity: { enum: ["error", "warning", "note"] },
          message: { type: "string", maxLength: 1000 },
          fix: { type: ["string", "null"], maxLength: 1000 },
        },
      },
    },
  },
};

/** What a batch records about its latest review. */
export type BatchReview = {
  state: "complete" | "failed";
  runId: string | null;
  /** The prompt file and the SHA-256 of the exact text the steward ran with. */
  prompt: { path: string; digest: string };
  startedAt: number;
  finishedAt: number;
  /** False when the batch or its neighborhood was too large to read whole, or the model failed. */
  complete: boolean;
  summary: string;
  findings: Finding[];
  error: string | null;
};

type Op = { ref: string; operation: string; type: string; id?: string; attributes: Record<string, unknown> };
type Row = { ref: string; operation: Op; confidence: number | null; reason: string | null; state: string; evidence?: EvidenceItem[] };

/** Structural types the steward exempts from the owner and isolation checks. */
const structural = new Set(["KnowledgeGraph", "GraphContextTemplate", "DecisionControlTemplate", "DecisionType", "MetricDefinition"]);

/** The owner's node: the Organization bound to this Wiki's organization. */
function ownerOf(graph: Graph, who: AppIdentity) {
  if (!who.organizationId) return null;
  const owners = graph.nodes.filter((node) => !node.archived && node.typeId === core.organization && node.properties.organization_id === who.organizationId);
  return owners.length === 1 ? owners[0] : null;
}

/** The batch's operations and the existing records they touch, as the steward reads them. */
function reviewContext(graph: Graph, who: AppIdentity, batch: typeof graphBatches.$inferSelect, rows: Row[]) {
  const typeNames = new Map(graph.types.map((type) => [type.id, type.name]));
  const nodes = new Map(graph.nodes.filter((node) => !node.archived).map((node) => [node.id, node]));
  const owner = ownerOf(graph, who);
  const touched = new Set<string>();
  const read = rows.slice(0, operationLimit);
  for (const { operation: op } of read) {
    for (const value of [op.id, op.attributes.id, op.attributes.fromId, op.attributes.toId])
      if (typeof value === "string" && nodes.has(value)) touched.add(value);
  }
  const neighbors = [...touched].slice(0, neighborLimit).map((id) => {
    const node = nodes.get(id)!;
    const edges = graph.edges.filter((edge) => !edge.archived && (edge.fromId === id || edge.toId === id));
    return {
      id, type: typeNames.get(node.typeId) ?? null, title: node.title, summary: node.summary, source: node.source,
      relationships: edges.slice(0, edgesPerNeighbor).map((edge) => {
        const other = nodes.get(edge.fromId === id ? edge.toId : edge.fromId);
        return { type: typeNames.get(edge.typeId) ?? null, direction: edge.fromId === id ? "out" : "in", other: other ? { id: other.id, type: typeNames.get(other.typeId) ?? null, title: other.title } : null };
      }),
      moreRelationships: Math.max(0, edges.length - edgesPerNeighbor),
    };
  });
  const complete = rows.length <= operationLimit && touched.size <= neighborLimit && neighbors.every((node) => node.moreRelationships === 0);
  return {
    complete,
    data: {
      mode: "batch",
      owner: owner ? { id: owner.id, title: owner.title } : null,
      batch: { id: batch.id, title: batch.title, purpose: batch.purpose, source: batch.source, policy: batch.policy, operations: rows.length },
      types: Object.fromEntries(typeNames),
      operations: read.map((row) => ({ ...row, typeName: typeNames.get(String(row.operation.attributes.typeId)) ?? null })),
      neighbors,
      complete,
    },
  };
}

/** Checks that need no judgment, run before the steward so a model failure still reports them. */
export function batchChecks(graph: Graph, who: AppIdentity, rows: Row[]): Finding[] {
  const typeNames = new Map(graph.types.map((type) => [type.id, type.name]));
  const owner = ownerOf(graph, who);
  const live = rows.filter((row) => row.state !== "rejected");
  const idOf = (row: Row) => String(row.operation.attributes.id ?? row.ref);
  const refToId = new Map(live.map((row) => [row.ref, idOf(row)]));
  const resolve = (value: unknown) => refToId.get(String(value)) ?? String(value);
  const edges = [
    ...graph.edges.filter((edge) => !edge.archived).map((edge) => ({ type: typeNames.get(edge.typeId), fromId: edge.fromId, toId: edge.toId })),
    ...live.filter((row) => row.operation.type === "graph-edge").map((row) => ({
      type: typeNames.get(String(row.operation.attributes.typeId)), fromId: resolve(row.operation.attributes.fromId), toId: resolve(row.operation.attributes.toId),
    })),
  ];
  const partOf = (id: string) => edges.filter((edge) => edge.type === "part_of" && edge.fromId === id).map((edge) => edge.toId);
  // The owner and its business units: what a Project may be part_of.
  const ownerScope = new Set(owner ? [owner.id, ...edges.filter((edge) => edge.type === "part_of" && edge.toId === owner.id).map((edge) => edge.fromId)] : []);
  const findings: Finding[] = [];
  for (const row of live.filter((item) => item.operation.type === "graph-node" && item.operation.operation === "create")) {
    const id = idOf(row), typeName = typeNames.get(String(row.operation.attributes.typeId));
    const title = String(row.operation.attributes.title ?? row.ref);
    if (row.operation.attributes.typeId === core.project && owner && !row.operation.attributes.source && !partOf(id).some((parent) => ownerScope.has(parent)))
      findings.push({
        ref: row.ref, rule: "project.foreign", severity: "error",
        message: `Project "${title}" is not part_of ${owner.title} or one of its business units and has no Planning source, so it is not the owner's own work.`,
        fix: `Relate it part_of ${owner.title} if it is the owner's work; otherwise recast it as evidence (a Document about the segment or problem it informs) instead of a Project.`,
      });
    if (typeName && !structural.has(typeName) && !edges.some((edge) => edge.fromId === id || edge.toId === id))
      findings.push({
        ref: row.ref, rule: "node.isolated", severity: "warning",
        message: `${typeName} "${title}" has no relationships, so nothing connects it to ${owner?.title ?? "the owner"}.`,
        fix: "Add the relationship its body or summary implies.",
      });
  }
  if (!owner && who.organizationId)
    findings.push({ ref: null, rule: "owner.unknown", severity: "warning", message: "No single Organization in this Wiki is bound to its organization, so owner checks did not run.", fix: null });
  return findings;
}

/** One finding per operation and rule; the deterministic check wins over the model's restatement. */
function merge(checks: Finding[], model: Finding[]) {
  const seen = new Set(checks.map((item) => `${item.ref}|${item.rule}`));
  return [...checks, ...model.filter((item) => !seen.has(`${item.ref}|${item.rule}`))];
}

const loadRows = async (db: Database, batchId: string): Promise<Row[]> =>
  live(await loadOperations(db, batchId))
    .map((row) => ({ ref: row.ref, operation: row.operation as unknown as Op, confidence: row.confidence, reason: row.reason, state: row.state, evidence: evidenceList.parse(row.evidence) }));

/** Review a submitted batch and save the findings on it. Never throws: a review
 * that cannot run is recorded as failed, and the batch is unaffected either way. */
async function executeReview(db: Database, who: AppIdentity, host: WorkflowHost<"interactive" | "schedule">, batchId: string, jobId: string, leaseId: string, reservedRunId?: string): Promise<BatchReview> {
  const startedAt = Date.now();
  const prompt = { path: promptPath, digest: await sha256Hex(stewardPrompt) };
  const [batch] = await db.select().from(graphBatches).where(eq(graphBatches.id, batchId));
  if (!batch) throw new Response("Batch not found", { status: 404 });
  if (batch.state === "open" || batch.state === "discarded") throw new Response("Only a submitted batch is reviewed", { status: 409 });
  const rows = await loadRows(db, batch.id);
  const graph = await readGraph(db, who);
  const checks = batchChecks(graph, who, rows);
  const { complete, data } = reviewContext(graph, who, batch, rows);
  let runId: string | null = null;
  let review: BatchReview;
  try {
    const run = await host.call("workflow.start", { workflow: reviewWorkflow, id: reservedRunId ?? crypto.randomUUID(), inputs: { [`${reviewStep}.inputs.batchId`]: batch.id } });
    runId = run.id;
    // Capture the exact inputs, including retained citations; a discovery-run source
    // is an app preview reference, never an inferred platform workflow link.
    const inputs = JSON.parse(JSON.stringify({ ...data, checks, prompt }));
    const sources = [
      { kind: "app-record", installationId: who.installationId, recordType: "change-batch", recordId: batch.id, label: "Onto batch" },
      ...rows.slice(0, operationLimit).flatMap((row) => (row.evidence ?? []).map((evidence) => ({
        kind: ["platform-user", "operating-user", "platform"].includes(evidence.provider) ? "platform" : "connector",
        provider: evidence.provider, recordId: evidence.recordId,
        ...(evidence.uri ? { url: evidence.uri } : {}), operationRef: row.ref,
      }))),
    ];
    await host.call("session.append", {
      runId, entry: { id: reviewStep, parentId: null, kind: "checkpoint", step: reviewStep, at: new Date().toISOString(),
        data: { format: "outfitter-step-evidence-v1", inputs, sources, complete } },
    });
    const { output } = await host.call("inference.generate", {
      runId, step: reviewStep, checkpointId: reviewStep, instructions: stewardPrompt, schema: answerSchema,
      data: inputs,
    });
    const answer = stewardAnswer.parse(output);
    // A finding about an operation the batch does not have is the model's mistake; keep it at batch level.
    const refs = new Set(rows.map((row) => row.ref));
    const findings = merge(checks, answer.findings.map((item) => (item.ref && !refs.has(item.ref) ? { ...item, ref: null } : item)));
    review = { state: "complete", runId, prompt, startedAt, finishedAt: Date.now(), complete, summary: answer.summary, findings, error: null };
  } catch (error) {
    const message = error instanceof Response ? `${error.status} ${await error.text().catch(() => "")}`.trim() : String(error);
    review = { state: "failed", runId, prompt, startedAt, finishedAt: Date.now(), complete: false, summary: "", findings: checks, error: message.slice(0, 500) };
  }
  if (runId) {
    const counts = Object.fromEntries((["error", "warning", "note"] as const).map((severity) => [severity, review.findings.filter((item) => item.severity === severity).length]));
    await host.call("workflow.collect", {
      runId, slot: `${reviewStep}.outputs.findings`,
      value: { batchId: batch.id, state: review.state, complete: review.complete, prompt, counts, findings: review.findings, error: review.error },
    }).catch(() => undefined);
  }
  await db.update(graphBatches).set({ review }).where(and(eq(graphBatches.id, batch.id), eq(graphBatches.reviewJobId, jobId), sql`exists (select 1 from onto_review_jobs where id = ${jobId} and state = 'running' and leaseId = ${leaseId} and leaseUntil > ${Date.now()})`));
  return review;
}

const maxAttempts = 4;
const leaseMs = 120_000;

/** Claim and execute one durable job. A lease token fences late completions. */
export async function processReviewJob(db: Database, who: AppIdentity, host: WorkflowHost<"interactive" | "schedule">, jobId: string, reservedRunId?: string): Promise<BatchReview | null> {
  const now = Date.now(), leaseId = crypto.randomUUID();
  const [job] = await db.update(ontoReviewJobs).set({ state: "running", leaseId, leaseUntil: now + leaseMs, attempts: sql`${ontoReviewJobs.attempts} + 1` })
    .where(and(eq(ontoReviewJobs.id, jobId), sql`${ontoReviewJobs.attempts} < ${maxAttempts}`,
      or(and(eq(ontoReviewJobs.state, "pending"), lte(ontoReviewJobs.nextAttemptAt, now)),
        and(eq(ontoReviewJobs.state, "running"), lte(ontoReviewJobs.leaseUntil, now)))))
    .returning();
  if (!job) return null;
  try {
    const [batch] = await db.select().from(graphBatches).where(eq(graphBatches.id, job.batchId));
    const digest = await batchContentDigest(await loadOperations(db, job.batchId));
    if (!batch || batch.state === "open" || batch.state === "discarded" || batch.reviewJobId !== job.id || digest !== job.contentDigest) {
      await db.update(ontoReviewJobs).set({ state: "superseded", leaseId: null, leaseUntil: null })
        .where(and(eq(ontoReviewJobs.id, job.id), eq(ontoReviewJobs.leaseId, leaseId), eq(ontoReviewJobs.state, "running"), sql`${ontoReviewJobs.leaseUntil} > ${Date.now()}`));
      return null;
    }
    const review = await executeReview(db, who, host, job.batchId, job.id, leaseId, reservedRunId);
    const failed = review.state === "failed";
    const settled = await db.update(ontoReviewJobs).set({ state: failed ? (job.attempts >= maxAttempts ? "failed" : "pending") : "complete", leaseId: null, leaseUntil: null,
      nextAttemptAt: Date.now() + 60_000 * 2 ** (job.attempts - 1), error: review.error })
      .where(and(eq(ontoReviewJobs.id, job.id), eq(ontoReviewJobs.leaseId, leaseId), eq(ontoReviewJobs.state, "running"), sql`${ontoReviewJobs.leaseUntil} > ${Date.now()}`)).returning();
    return settled.length ? review : null;
  } catch (error) {
    await db.update(ontoReviewJobs).set({ state: job.attempts >= maxAttempts ? "failed" : "pending", leaseId: null, leaseUntil: null,
      nextAttemptAt: Date.now() + 60_000 * 2 ** (job.attempts - 1), error: String(error).slice(0, 500) })
      .where(and(eq(ontoReviewJobs.id, job.id), eq(ontoReviewJobs.leaseId, leaseId), eq(ontoReviewJobs.state, "running"), sql`${ontoReviewJobs.leaseUntil} > ${Date.now()}`));
    throw error;
  }
}

/** Explicit member re-review supersedes earlier attempts. */
export async function reviewBatchOntology(db: Database, who: AppIdentity, host: WorkflowHost<"interactive">, batchId: string): Promise<BatchReview> {
  const [batch] = await db.select().from(graphBatches).where(eq(graphBatches.id, batchId));
  if (!batch) throw new Response("Batch not found", { status: 404 });
  if (batch.state === "open" || batch.state === "discarded") throw new Response("Only a submitted batch is reviewed", { status: 409 });
  const id = crypto.randomUUID(), now = Date.now();
  const contentDigest = await batchContentDigest(await loadOperations(db, batchId));
  await db.batch([
    db.update(graphBatches).set({ reviewJobId: id }).where(eq(graphBatches.id, batchId)),
    db.insert(ontoReviewJobs).values({ id, batchId, contentDigest, state: "pending", nextAttemptAt: now, createdAt: now }),
  ]);
  const review = await processReviewJob(db, who, host, id);
  if (!review) throw new Response("Review could not be claimed", { status: 409 });
  return review;
}

/** Process a bounded number of due jobs using a member-authorized interactive host. */
export async function processDueReviewJobs(db: Database, who: AppIdentity, host: WorkflowHost<"interactive" | "schedule">, limit = 10) {
  const now = Date.now();
  // A worker may die during its final lease; make that terminal on recovery.
  await failExpiredReviewJobs(db, now);
  const jobs = await db.select().from(ontoReviewJobs).where(and(sql`${ontoReviewJobs.attempts} < ${maxAttempts}`,
    or(and(eq(ontoReviewJobs.state, "pending"), lte(ontoReviewJobs.nextAttemptAt, now)),
      and(eq(ontoReviewJobs.state, "running"), lte(ontoReviewJobs.leaseUntil, now))))).limit(Math.min(limit, 10));
  for (const job of jobs) await processReviewJob(db, who, host, job.id).catch(() => null);
  return jobs.length;
}

type RequestLocals = { cfContext?: { waitUntil?: (work: Promise<unknown>) => void } };
/** Best effort immediate wake-up; the job itself is already durable. */
export function reviewInBackground(locals: unknown, db: Database, who: AppIdentity, batchId: string) {
  const work = (async () => {
    const [batch] = await db.select().from(graphBatches).where(eq(graphBatches.id, batchId));
    if (batch?.reviewJobId) await processReviewJob(db, who, workflowHost<"interactive">(locals as never), batch.reviewJobId);
  })().catch(() => null);
  (locals as RequestLocals).cfContext?.waitUntil?.(work);
}

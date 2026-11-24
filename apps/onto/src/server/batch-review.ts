// The ontology steward's automatic review of a submitted change batch
// (agent/ontology-steward.md, "Review one batch"). Submitting a batch starts one
// batch-review workflow run: deterministic checks, then the steward prompt over
// the batch's operations and the records they touch. Its findings are saved on
// the batch with the run's ID; the run's logs are the audit trail, and a re-review
// is a new run. Once a submitted batch's review finishes, the steward approves what it
// found clean and leaves the rest for a member (stewardApprove, docs/batch-review.md).
import { type AppIdentity, sha256Hex } from "@ai-outfitter/app-sdk/server";
import { type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import stewardPrompt from "../../agent/ontology-steward.md?raw";
import { core, type Graph } from "../lib/graph";
import { batchAdvice, finding, type Finding, stageTypes } from "./batch-advice";
import { readGraph } from "./graph";
import { type Database, live, loadOperations, batchContentDigest, approveAfterReview, type StewardDecision } from "./graph-batches";
import { graphBatches, ontoReviewJobs } from "./schema";
import { wikiHome } from "./wiki-home";

export const reviewWorkflow = "batch-review";
export const reviewStep = "review";
export const promptPath = "apps/onto/agent/ontology-steward.md";
/** An abandoned final lease is terminal and must not remain running forever. */
async function failExpiredReviewJobs(db: Database, now = Date.now()) {
  return db.update(ontoReviewJobs).set({state:"failed",leaseId:null,leaseUntil:null,error:"Review lease expired after maximum attempts"})
    .where(and(eq(ontoReviewJobs.state, "running"),lte(ontoReviewJobs.leaseUntil, now),sql`${ontoReviewJobs.attempts} >= ${maxAttempts}`)).returning();
}
/** Each model call's data stays well under the platform's 64 KB step cap. */
export const partBudget = 48 * 1024;
/** Model calls for one review; a batch past this many parts is reviewed in part. */
const partLimit = 12;
const partConcurrency = 3;
/** Existing records shown per part, and relationships shown per record. */
const neighborLimit = 60;
const edgesPerNeighbor = 12;
/** What the steward reads of each operation: enough to judge it, not the whole source. */
const bodyExcerpt = 600, quoteExcerpt = 200, reasonExcerpt = 300, evidencePerOperation = 3;

export { finding, type Finding };
/** The steward's own finding: refs it covers, and any types it proposes, by name. */
const modelFinding = z.strictObject({
  ref: z.string().max(80).nullable(),
  refs: z.array(z.string().max(80)).max(200).default([]),
  rule: z.string().min(1).max(64),
  severity: z.enum(["error", "warning", "note"]),
  message: z.string().min(1).max(1000),
  fix: z.string().max(1000).nullable(),
  types: z.array(z.strictObject({
    category: z.enum(["node", "edge"]), name: z.string().max(64), title: z.string().max(120), body: z.string().max(2000),
    properties: z.array(z.strictObject({ name: z.string().max(48), type: z.enum(["string", "number", "boolean"]), description: z.string().max(500) })).max(32),
    from: z.array(z.string().max(64)).max(20), to: z.array(z.string().max(64)).max(20),
  })).max(6).default([]),
});
const stewardAnswer = z.strictObject({
  summary: z.string().max(1000),
  findings: z.array(modelFinding).max(100),
});
const strings = (maxLength: number) => ({ type: "array", maxItems: 20, items: { type: "string", maxLength } });
/** JSON Schema of the steward's answer, for inference.generate. */
const answerSchema = {
  type: "object", additionalProperties: false, required: ["summary", "findings"],
  properties: {
    summary: { type: "string", maxLength: 1000 },
    findings: {
      type: "array", maxItems: 100,
      items: {
        type: "object", additionalProperties: false, required: ["ref", "refs", "rule", "severity", "message", "fix", "types"],
        properties: {
          ref: { type: ["string", "null"], maxLength: 80 },
          refs: { type: "array", maxItems: 200, items: { type: "string", maxLength: 80 } },
          rule: { type: "string", maxLength: 64 },
          severity: { enum: ["error", "warning", "note"] },
          message: { type: "string", maxLength: 1000 },
          fix: { type: ["string", "null"], maxLength: 1000 },
          types: {
            type: "array", maxItems: 6,
            items: {
              type: "object", additionalProperties: false, required: ["category", "name", "title", "body", "properties", "from", "to"],
              properties: {
                category: { enum: ["node", "edge"] }, name: { type: "string", maxLength: 64 }, title: { type: "string", maxLength: 120 }, body: { type: "string", maxLength: 2000 },
                properties: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false, required: ["name", "type", "description"],
                  properties: { name: { type: "string", maxLength: 48 }, type: { enum: ["string", "number", "boolean"] }, description: { type: "string", maxLength: 500 } } } },
                from: strings(64), to: strings(64),
              },
            },
          },
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
  /** How much of the batch the steward read: operations read of the total, in how many model calls. */
  coverage?: { operations: number; read: number; parts: number };
  /** The batch state it reviewed: an open draft or a submitted batch. */
  stage?: "open" | "submitted";
  summary: string;
  findings: Finding[];
  error: string | null;
  /** What the steward approved after this review, and what it left for a member. */
  decision?: StewardDecision;
};

type Op = { ref: string; operation: string; type: string; id?: string; attributes: Record<string, unknown> };
type Row = { ref: string; operation: Op; evidence: unknown; confidence: number | null; reason: string | null; state: string };

/** Structural types the steward exempts from the owner and isolation checks. */
const structural = new Set(["KnowledgeGraph", "GraphContextTemplate", "DecisionControlTemplate", "DecisionType", "MetricDefinition"]);

/** The owner's node: the Organization this Wiki's home resolves to (its root). */
function ownerOf(graph: Graph, who: AppIdentity) {
  const id = wikiHome(graph, who).organizationId;
  return id ? graph.nodes.find((node) => node.id === id) ?? null : null;
}

const cut = (value: unknown, length: number) => typeof value === "string" && value.length > length ? `${value.slice(0, length)}…` : value;
/** One operation as the steward reads it: bodies and quotes cut to excerpts, citations kept. */
function compactOperation(row: Row, typeName: string | null) {
  const attributes = Object.fromEntries(Object.entries(row.operation.attributes).map(([key, value]) => [key,
    key === "body" ? cut(value, bodyExcerpt)
      : key === "properties" && value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, cut(item, 200)]))
        : cut(value, 2000)]));
  const evidence = (Array.isArray(row.evidence) ? row.evidence : []).slice(0, evidencePerOperation).map((item: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(item ?? {}).filter(([key]) => ["provider", "recordId", "uri", "version", "observedAt", "quote"].includes(key)).map(([key, value]) => [key, key === "quote" ? cut(value, quoteExcerpt) : value])));
  return { ref: row.ref, operation: { ...row.operation, attributes }, typeName, evidence, moreEvidence: Math.max(0, (Array.isArray(row.evidence) ? row.evidence.length : 0) - evidencePerOperation),
    confidence: row.confidence, reason: cut(row.reason, reasonExcerpt), state: row.state };
}
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Types first, then nodes grouped by type and parent, each followed by its own relationships. */
function readingOrder(rows: Row[]) {
  const created = new Map(rows.filter((row) => row.operation.type === "graph-node").flatMap((row) => [[row.ref, row], ...(typeof row.operation.attributes.id === "string" ? [[row.operation.attributes.id, row] as const] : [])]));
  const edges = rows.filter((row) => row.operation.type === "graph-edge");
  const parentOf = new Map<string, string>();
  const edgesFrom = new Map<string, Row[]>();
  const loose: Row[] = [];
  for (const edge of edges) {
    const from = created.get(String(edge.operation.attributes.fromId)) ?? created.get(String(edge.operation.attributes.toId));
    if (!from) { loose.push(edge); continue; }
    if (!parentOf.has(from.ref)) parentOf.set(from.ref, String(edge.operation.attributes.toId));
    edgesFrom.set(from.ref, [...(edgesFrom.get(from.ref) ?? []), edge]);
  }
  const nodes = rows.filter((row) => row.operation.type === "graph-node")
    .map((row, index) => ({ row, index, key: `${String(row.operation.attributes.typeId ?? "")}|${parentOf.get(row.ref) ?? ""}` }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.index - b.index);
  return [
    ...rows.filter((row) => row.operation.type === "graph-type"),
    ...nodes.flatMap(({ row }) => [row, ...(edgesFrom.get(row.ref) ?? [])]),
    ...loose,
  ];
}

/** The batch read in parts that each fit `budget`: every part carries the batch, its owner, its
 * new types and the checks about its operations, then as many operations and neighbors as fit. */
export function reviewParts(graph: Graph, who: AppIdentity, batch: Pick<typeof graphBatches.$inferSelect, "id" | "title" | "purpose" | "source" | "policy" | "state">, rows: Row[], checks: Finding[], budget = partBudget) {
  const typeNames = new Map(graph.types.map((type) => [type.id, type.name]));
  const nodes = new Map(graph.nodes.filter((node) => !node.archived).map((node) => [node.id, node]));
  const owner = ownerOf(graph, who);
  const newTypes = rows.filter((row) => row.operation.type === "graph-type").map((row) => ({
    ref: row.ref, operation: row.operation.operation, name: row.operation.attributes.name ?? row.operation.id, category: row.operation.attributes.category,
    properties: Array.isArray(row.operation.attributes.properties) ? row.operation.attributes.properties.map((property: { name?: unknown; type?: unknown }) => `${property?.name}:${property?.type}`) : undefined,
    endpoints: (row.operation.attributes.ontology as { endpoints?: unknown } | undefined)?.endpoints,
  }));
  const neighbor = (id: string) => {
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
  };
  const touches = (row: Row) => [row.operation.id, row.operation.attributes.id, row.operation.attributes.fromId, row.operation.attributes.toId]
    .filter((value): value is string => typeof value === "string" && nodes.has(value));
  const shortCheck = (item: Finding) => ({ ref: item.ref, ...(item.refs ? { refs: item.refs.slice(0, 20), moreRefs: Math.max(0, item.refs.length - 20) } : {}),
    rule: item.rule, severity: item.severity, message: cut(item.message, 300), fix: cut(item.fix, 300), staged: item.stage ? item.stage.proposals.length : undefined });
  // Every type by ID, unless that alone would crowd out the operations: then the ones the batch names.
  const named = new Set(rows.flatMap((row) => [row.operation.attributes.typeId, row.operation.id].map(String)));
  const all = Object.fromEntries(typeNames);
  const types = size(all) < budget / 4 ? all : Object.fromEntries([...typeNames].filter(([id]) => named.has(id)));
  const ordered = readingOrder(rows);
  const parts: { data: Record<string, unknown>; refs: string[]; neighborsComplete: boolean }[] = [];
  const base = (index: number) => ({
    mode: "batch",
    owner: owner ? { id: owner.id, title: owner.title } : null,
    batch: { id: batch.id, title: batch.title, purpose: cut(batch.purpose, 1000), source: batch.source, policy: batch.policy, state: batch.state, operations: rows.length },
    part: { index: index + 1, of: 0, operations: 0 },
    types,
    newTypes,
    complete: false,
  });
  let next = 0;
  while (next < ordered.length && parts.length < partLimit) {
    const data = base(parts.length);
    const operations: ReturnType<typeof compactOperation>[] = [];
    const refs: string[] = [];
    const seen = new Set<string>();
    const neighbors: ReturnType<typeof neighbor>[] = [];
    const given = new Set<Finding>();
    const partChecks = checks.filter((item) => item.ref === null && !item.refs).map(shortCheck);
    let used = size({ ...data, operations, neighbors, checks: partChecks }) + 64;
    let neighborsComplete = true;
    while (next < ordered.length) {
      const row = ordered[next];
      const op = compactOperation(row, typeNames.get(String(row.operation.attributes.typeId)) ?? null);
      const mine = checks.filter((item) => !given.has(item) && (item.ref === row.ref || item.refs?.includes(row.ref)));
      for (const item of mine) given.add(item);
      const cost = size(op) + size(mine.map(shortCheck)) + 2;
      if (operations.length && used + cost > budget) { for (const item of mine) given.delete(item); break; }
      operations.push(op); refs.push(row.ref); partChecks.push(...mine.map(shortCheck)); used += cost; next++;
      for (const id of touches(row)) {
        if (seen.has(id)) continue;
        seen.add(id);
        const item = neighbor(id), more = size(item) + 1;
        if (neighbors.length >= neighborLimit || used + more > budget) { neighborsComplete = false; continue; }
        neighbors.push(item); used += more;
      }
    }
    parts.push({ data: { ...data, operations, neighbors, checks: partChecks }, refs, neighborsComplete });
  }
  const read = parts.reduce((total, part) => total + part.refs.length, 0);
  const complete = read === rows.length && parts.every((part) => part.neighborsComplete);
  for (const part of parts) Object.assign(part.data, { part: { index: (part.data.part as { index: number }).index, of: parts.length, operations: part.refs.length }, complete });
  return { parts, complete, coverage: { operations: rows.length, read, parts: parts.length } };
}

/** Checks that need no judgment, run before the steward so a model failure still reports them. */
export function batchChecks(graph: Graph, who: AppIdentity, rows: Row[], batchId = ""): Finding[] {
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
  // The staging advice runs on the whole batch too: missing and sprawling types, card quality.
  return [...findings, ...batchAdvice(graph, live, batchId)];
}

/** One finding per operation and rule; the deterministic check wins over the model's restatement,
 * and the same batch-level finding from two parts is kept once. */
function merge(checks: Finding[], model: Finding[]) {
  const seen = new Set(checks.map((item) => `${item.ref}|${item.rule}`));
  const kept = new Set<string>();
  return [...checks, ...model.filter((item) => {
    if (seen.has(`${item.ref}|${item.rule}`)) return false;
    const key = item.ref === null ? `${item.rule}|${item.message}` : `${item.ref}|${item.rule}`;
    if (kept.has(key)) return false;
    kept.add(key);
    return true;
  })];
}

/** The steward's finding as saved: refs it covers checked against the batch, and its types as stageable proposals. */
function savedFinding(graph: Graph, batchId: string, refs: Set<string>, item: z.infer<typeof modelFinding>): Finding {
  const covered = item.refs.filter((ref) => refs.has(ref));
  const stage = item.types.length ? stageTypes(graph, batchId, item.rule, item.types, covered) : null;
  return {
    // A finding about an operation the batch does not have is the model's mistake; keep it at batch level.
    ref: item.ref && refs.has(item.ref) ? item.ref : null,
    ...(covered.length ? { refs: covered } : {}),
    rule: item.rule, severity: item.severity, message: item.message, fix: item.fix,
    ...(stage && (stage.proposals.length || stage.move.length) ? { stage } : {}),
  };
}

/** Run `work` over `items`, at most `limit` at a time, in order. */
async function pooled<T, R>(items: T[], limit: number, latestStart: number, work: (item: T) => Promise<R>) {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && Date.now() < latestStart) {
      const index = next++;
      try {
        results[index] = await work(items[index]);
      } catch (error) {
        next = items.length;
        throw error;
      }
    }
  });
  for (const result of await Promise.allSettled(workers)) {
    if (result.status === "rejected") throw result.reason;
  }
  return results;
}

const loadRows = async (db: Database, batchId: string): Promise<Row[]> =>
  live(await loadOperations(db, batchId))
    .map((row) => ({ ref: row.ref, operation: row.operation as unknown as Op, evidence: row.evidence, confidence: row.confidence, reason: row.reason, state: row.state }));

/** Review a batch, open or submitted, and save the findings on it. Never throws: a review
 * that cannot run is recorded as failed, and the batch is unaffected either way.
 * The steward reads it in parts that each fit the platform's step cap, one model
 * call per part; the built-in checks cover the whole batch. */
async function executeReview(db: Database, who: AppIdentity, host: WorkflowHost<"interactive" | "schedule">, batchId: string, jobId: string, leaseId: string, reservedRunId: string, startedAt: number): Promise<BatchReview> {
  const prompt = { path: promptPath, digest: await sha256Hex(stewardPrompt) };
  const [batch] = await db.select().from(graphBatches).where(eq(graphBatches.id, batchId));
  if (!batch) throw new Response("Batch not found", { status: 404 });
  if (batch.state === "discarded") throw new Response("A discarded batch is not reviewed", { status: 409 });
  const stage = batch.state === "open" ? "open" as const : "submitted" as const;
  const rows = await loadRows(db, batch.id);
  const graph = await readGraph(db, who);
  const checks = batchChecks(graph, who, rows, batch.id);
  const { parts, complete, coverage } = reviewParts(graph, who, batch, rows, checks);
  const refs = new Set(rows.map((row) => row.ref));
  let runId: string | null = null;
  let review: BatchReview;
  try {
    const run = await host.call("workflow.start", { workflow: reviewWorkflow, id: reservedRunId, inputs: { [`${reviewStep}.inputs.batchId`]: batch.id } });
    runId = run.id;
    // Allow five minutes for the last inference and at least one minute for settlement.
    const answers = await pooled(parts, partConcurrency, startedAt + 8 * 60_000, async (part) => {
      const { output } = await host.call("inference.generate", {
        runId: runId!, step: reviewStep, instructions: stewardPrompt, schema: answerSchema,
        // Plain JSON: this part's records, the checks about them and the prompt digest.
        data: JSON.parse(JSON.stringify({ ...part.data, prompt })),
      });
      return stewardAnswer.parse(output);
    });
    if (!answers.length && parts.length) throw new Error("No steward inference completed within the review budget");
    const findings = merge(checks, answers.flatMap((answer) => answer.findings.map((item) => savedFinding(graph, batch.id, refs, item))));
    coverage.read = parts.slice(0, answers.length).reduce((sum, part) => sum + part.refs.length, 0);
    coverage.parts = answers.length;
    const read = coverage.read === coverage.operations ? "" : ` Read ${coverage.read} of ${coverage.operations} operations.`;
    const summary = answers.length === 1 ? `${answers[0].summary}${read}`
      : `Read in ${coverage.parts} parts.${read} ${answers.map((answer) => answer.summary).filter(Boolean).join(" ")}`;
    review = { state: "complete", runId, prompt, startedAt, finishedAt: Date.now(), complete: complete && answers.length === parts.length, coverage, stage, summary: summary.trim().slice(0, 1000), findings, error: null };
  } catch (error) {
    const message = error instanceof Response ? `${error.status} ${await error.text().catch(() => "")}`.trim() : String(error);
    review = { state: "failed", runId, prompt, startedAt, finishedAt: Date.now(), complete: false, coverage: { ...coverage, read: 0 }, stage, summary: "", findings: checks, error: message.slice(0, 500) };
  }
  if (runId) {
    const counts = Object.fromEntries((["error", "warning", "note"] as const).map((severity) => [severity, review.findings.filter((item) => item.severity === severity).length]));
    await host.call("workflow.collect", {
      runId, slot: `${reviewStep}.outputs.findings`,
      value: { batchId: batch.id, state: review.state, complete: review.complete, coverage: review.coverage ?? null, prompt, counts, findings: review.findings, error: review.error },
    }).catch(() => undefined);
  }
  await db.update(graphBatches).set({ review }).where(and(eq(graphBatches.id, batch.id), eq(graphBatches.reviewJobId, jobId), sql`exists (select 1 from onto_review_jobs where id = ${jobId} and state = 'running' and leaseId = ${leaseId} and leaseUntil > ${Date.now()})`));
  return review;
}

const maxAttempts = 4;
// The host allows 14 minutes for a schedule. Fence abandoned work beyond that deadline.
const leaseMs = 15 * 60_000;

/** Claim and execute one durable job. A lease token fences late completions. */
export async function processReviewJob(db: Database, who: AppIdentity, host: WorkflowHost<"interactive" | "schedule">, jobId: string, reservedRunId?: string, dispatchStartedAt = Date.now()): Promise<BatchReview | null> {
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
    if (!batch || batch.state === "discarded" || batch.reviewJobId !== job.id || digest !== job.contentDigest) {
      await db.update(ontoReviewJobs).set({ state: "superseded", leaseId: null, leaseUntil: null })
        .where(and(eq(ontoReviewJobs.id, job.id), eq(ontoReviewJobs.leaseId, leaseId), eq(ontoReviewJobs.state, "running"), sql`${ontoReviewJobs.leaseUntil} > ${Date.now()}`));
      return null;
    }
    // Honor the run ID already returned to an agent waiting for this review.
    const runId = job.runId ?? reservedRunId ?? crypto.randomUUID();
    if (runId !== job.runId) await db.update(ontoReviewJobs).set({ runId }).where(and(eq(ontoReviewJobs.id, job.id), eq(ontoReviewJobs.leaseId, leaseId)));
    const review = await executeReview(db, who, host, job.batchId, job.id, leaseId, runId, dispatchStartedAt);
    const failed = review.state === "failed";
    // A retry gets a new run to name; the failed one stays in the run log.
    const settled = await db.update(ontoReviewJobs).set({ state: failed ? (job.attempts >= maxAttempts ? "failed" : "pending") : "complete", leaseId: null, leaseUntil: null,
      ...(failed ? { runId: crypto.randomUUID() } : {}), nextAttemptAt: Date.now() + 60_000 * 2 ** (job.attempts - 1), error: review.error })
      .where(and(eq(ontoReviewJobs.id, job.id), eq(ontoReviewJobs.leaseId, leaseId), eq(ontoReviewJobs.state, "running"), sql`${ontoReviewJobs.leaseUntil} > ${Date.now()}`)).returning();
    if (!settled.length) throw new Response("Review lease expired before settlement", { status: 409 });
    // A finished review of a batch that is (by now) submitted approves what it found clean.
    if (review.state !== "complete") return review;
    const decision = await approveAfterReview(db, who, job.batchId, job.id, review);
    return decision ? { ...review, decision } : review;
  } catch (error) {
    await db.update(ontoReviewJobs).set({ state: job.attempts >= maxAttempts ? "failed" : "pending", leaseId: null, leaseUntil: null, runId: crypto.randomUUID(),
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

/** A stale job must not use an occurrence reserved for a live batch. */
export async function processScheduledReview(db: Database, who: AppIdentity, host: WorkflowHost<"schedule">, runId: string) {
  const now = Date.now();
  await failExpiredReviewJobs(db, now);
  // Joining the batch pointer excludes every detached job, regardless of queue depth.
  // If a candidate is superseded or claimed concurrently, select the next current one.
  while (Date.now() - now < 5000) {
    const [job] = await db.select({ id: ontoReviewJobs.id }).from(ontoReviewJobs)
      .innerJoin(graphBatches, eq(graphBatches.reviewJobId, ontoReviewJobs.id))
      .where(and(sql`${ontoReviewJobs.attempts} < ${maxAttempts}`, or(
        and(eq(ontoReviewJobs.state, "pending"), lte(ontoReviewJobs.nextAttemptAt, now)),
        and(eq(ontoReviewJobs.state, "running"), lte(ontoReviewJobs.leaseUntil, now)))))
      .orderBy(ontoReviewJobs.nextAttemptAt, ontoReviewJobs.createdAt, ontoReviewJobs.id).limit(1);
    if (!job) return null;
    const review = await processReviewJob(db, who, host, job.id, runId, now);
    if (review) return review;
  }
  return null;
}

/** Queue a review of an open member batch's current draft. Each distinct draft is reviewed
 * once: a draft whose job is already the batch's is not queued again. */
export async function queueDraftReview(db: Database, batchId: string) {
  const [batch] = await db.select().from(graphBatches).where(eq(graphBatches.id, batchId));
  if (!batch || batch.state !== "open" || (batch.policy as { kind?: string }).kind !== "member") return null;
  const rows = await loadOperations(db, batchId);
  if (!live(rows).length) return null;
  const contentDigest = await batchContentDigest(rows);
  if (batch.reviewJobId) {
    const [current] = await db.select().from(ontoReviewJobs).where(eq(ontoReviewJobs.id, batch.reviewJobId));
    if (current?.contentDigest === contentDigest && current.state !== "superseded" && current.state !== "failed") return current.id;
  }
  const id = crypto.randomUUID(), now = Date.now();
  await db.batch([
    db.update(graphBatches).set({ reviewJobId: id, review: null }).where(and(eq(graphBatches.id, batchId), eq(graphBatches.state, "open"))),
    db.insert(ontoReviewJobs).values({ id, batchId, contentDigest, state: "pending", nextAttemptAt: now, createdAt: now }),
  ]);
  return id;
}

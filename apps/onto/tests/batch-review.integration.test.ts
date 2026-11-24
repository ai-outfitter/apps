import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/d1";
import { sealDueBatches } from "../src/server/graph-batches";
import { appWorker } from "./fixtures/initialized-worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { core } from "../src/lib/graph";
import { create } from "./fixtures/relators";

// The ontology steward reviews each submitted batch in a batch-review workflow
// run and attaches advisory findings. The run is the audit trail; the batch's
// policy decides exactly as it would without a review.
const owner = { userId: "owner", organizationId: "org", role: "owner" };
// Forerunner calling the Wiki, as platform dispatch forwards it.
const forerunner = { ...owner, actor: { kind: "app" as const, id: "forerunner" } };
const actions = "/api/internal/actions/v1/call";
const partOf = "71000000-0000-4000-8000-000000000032";
const uuid = (n: number) => `7c0e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cite = (recordId: string) => [{ provider: "web", recordId, quote: "VEG-05 grows tomatoes on the ISS." }];
const node = (ref: string, n: number, typeId: string, title: string, extra: object = {}) =>
  create(ref, "graph-node", { id: uuid(n), typeId, title, ...extra });
const edge = (ref: string, n: number, typeId: string, fromId: string, toId: string) =>
  create(ref, "graph-edge", { id: uuid(n), typeId, fromId, toId });

// biome-ignore lint/suspicious/noExplicitAny: public JSON responses under test.
type Json = Record<string, any>;
async function json(response: Response): Promise<Json> {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

/** A Wiki whose owner is Artera, with a workflow host that records the review run. */
async function fixture(answer: (input: Json) => unknown = () => ({ summary: "No further findings.", findings: [] })) {
  const calls: { operation: string; input: Json }[] = [];
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "onto-installation", {
    workflowHost: () => ({ call: async (operation, input) => {
      const body = input as Json;
      calls.push({ operation, input: body });
      try {
        if (operation === "workflow.start") return { ok: true, value: { id: body.id, workflow: body.workflow, created: true } };
        if (operation === "inference.generate") return { ok: true, value: { output: await answer(body) } };
        if (operation === "workflow.collect") return { ok: true, value: { run: "complete", steps: { review: "complete" } } };
        return { ok: false, status: 400, message: `Unexpected ${operation}` };
      } catch (error) {
        return { ok: false, status: 503, message: String(error) };
      }
    } }),
  });
  const scope = { organizationId: "org", installationId: app.installationId, userId: "owner", packageHash: "fixture", phase: "interactive" as const, expiresAt: Date.now() + 600_000 };
  const action = (name: string, input: object, identity: object = owner) =>
    app.call(actions, identity as typeof owner, { method: "POST", body: { action: name, input }, workflowHost: scope });
  const graphql = (query: string, variables: object, identity: object = owner) =>
    action("graph.mutate", { query, variables }, identity);
  try {
    // The owner's node, bound to the platform organization (existing Wikis add the binding by an editor's revision).
    const { types } = await json(await action("graph.read", {}));
    const organization = types.find((type: Json) => type.id === core.organization);
    await json(await action("graph.apply", { requestKey: "bind", operations: [
      { operation: "update", ref: "$org-type", type: "graph-type", id: core.organization, revision: organization.revision,
        attributes: { properties: [...organization.properties.filter((property: Json) => property.name !== "organization_id"), { name: "organization_id", type: "string", description: "Platform organization", required: false }] } },
      node("$artera", 1, core.organization, "Artera", { properties: { organization_id: "org" } }),
    ] }));
  } catch (error) {
    await app.dispose();
    throw error;
  }
  const page = (path: string, init: { method?: string; body?: unknown } = {}) =>
    app.call(`/api/apps/onto/batches/${path}`, owner as typeof owner, { ...init, workflowHost: scope });
  /** The batch once its background review has been saved. */
  const waitFor = async (batchId: string, done: (read: Json) => boolean, failure: string) => {
    const current = await json(await action("batch.get", { batchId }));
    if (done(current)) return current;
    await json(await app.call("/api/internal/workflow-host/v1", owner, {
      method: "POST",
      body: { phase: "schedule", input: { runId: crypto.randomUUID(), scheduledFor: Date.now(),
        schedule: { id: "queue", workflowId: "batch-review", inputs: {}, connectionId: null, resource: null } } },
      workflowHost: { ...scope, phase: "schedule", scheduleId: "queue" },
    }));
    const reviewed = await json(await action("batch.get", { batchId }));
    if (done(reviewed)) return reviewed;
    throw new Error(failure);
  };
  const reviewed = (batchId: string) => waitFor(batchId, (read) => !!read.batch.review, "The review was not saved");
  /** The batch once the steward has decided after its review. */
  const decided = (batchId: string) => waitFor(batchId, (read) => !!read.batch.review?.decision, "The steward did not decide");
  return { app, calls, action, graphql, page, reviewed, decided };
}

/** Forerunner's confidence batch: an external mission filed as a Project, part_of NASA rather than Artera. */
async function externalProjectBatch(f: Awaited<ReturnType<typeof fixture>>) {
  const policy = { kind: "confidence", threshold: 0.95, version: "test-1" };
  const { batch } = await json(await f.action("batch.open", { title: "Space research", source: { kind: "discovery-run", ref: "run-1" }, policy }, forerunner));
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [
    { operation: node("$nasa", 10, core.organization, "NASA"), evidence: cite("nasa"), confidence: 0.99 },
    { operation: node("$veg", 11, core.project, "VEG-05"), evidence: cite("veg"), confidence: 0.97, reason: "A space crop experiment." },
    { operation: edge("$veg-nasa", 12, partOf, "$veg", "$nasa"), evidence: cite("veg"), confidence: 0.97 },
    { operation: node("$tomato", 13, core.technology, "Dwarf tomato cultivar"), evidence: cite("veg"), confidence: 0.6 },
  ] }, forerunner));
  return batch.id as string;
}

test("a batch adding an external Project gets an error finding, and nothing that misses Artera commits by policy", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const batchId = await externalProjectBatch(f);
  const submitted = await json(await f.action("batch.submit", { batchId, summary: "Space crop research" }, forerunner));

  // The batch anchors to Artera: confident records that do not reach it wait for a member like the rest.
  assert.deepEqual(submitted.operations.map((op: Json) => [op.ref, op.state]),
    [["$nasa", "awaiting_review"], ["$veg", "awaiting_review"], ["$veg-nasa", "awaiting_review"], ["$tomato", "awaiting_review"]]);
  assert.equal(submitted.batch.state, "awaiting_review");
  // Submitting does not wait for the review; it is saved in the background.
  assert.equal(submitted.batch.review, null);
  assert.equal(f.calls.length, 0);

  const { review } = (await f.reviewed(batchId)).batch;
  assert.equal(review.state, "complete", review.error ?? undefined);
  const job = await f.app.database.prepare("SELECT state, attempts, contentDigest FROM onto_review_jobs WHERE batchId = ?").bind(batchId).first();
  assert.equal(job?.state, "complete");
  assert.equal(job?.attempts, 1);
  assert.match(String(job?.contentDigest), /^[a-f0-9]{64}$/);
  assert.equal(review.complete, true);
  const foreign = review.findings.find((item: Json) => item.rule === "project.foreign");
  assert.equal(foreign.ref, "$veg");
  assert.equal(foreign.severity, "error");
  assert.match(foreign.message, /VEG-05.*not part_of Artera/);
  const isolated = review.findings.find((item: Json) => item.rule === "node.isolated");
  assert.equal(isolated.ref, "$tomato");
  assert.equal(isolated.severity, "warning");

  // One batch-review run: the steward prompt over the batch, then its findings collected as the run's output.
  const started = f.calls.filter((call) => call.operation === "workflow.start");
  assert.equal(started.length, 1);
  assert.equal(started[0].input.workflow, "batch-review");
  assert.deepEqual(started[0].input.inputs, { "review.inputs.batchId": batchId });
  assert.equal(review.runId, started[0].input.id);
  const inference = f.calls.find((call) => call.operation === "inference.generate")!;
  assert.equal(inference.input.runId, review.runId);
  assert.match(inference.input.instructions, /## Review one batch/);
  assert.equal(inference.input.data.mode, "batch");
  assert.equal(inference.input.data.owner.title, "Artera");
  assert.equal(inference.input.data.operations.length, 4);
  assert.ok(inference.input.data.checks.some((item: Json) => item.rule === "project.foreign"));
  assert.match(review.prompt.digest, /^[a-f0-9]{64}$/);
  assert.equal(review.prompt.path, "apps/onto/agent/ontology-steward.md");
  const collected = f.calls.find((call) => call.operation === "workflow.collect")!;
  assert.equal(collected.input.slot, "review.outputs.findings");
  assert.equal(collected.input.value.batchId, batchId);
  assert.deepEqual(collected.input.value.counts, { error: 1, warning: 1, note: 0 });

  // Agents read the same review through the ChangeBatch document.
  const read = await json(await f.action("graph.graphql", { query: "query ($id: ID!) { changeBatch(id: $id) { review } }", variables: { id: batchId } }));
  assert.equal(read.data.changeBatch.review.runId, review.runId);
});

test("a Project part_of the owner passes, and the steward's own findings are kept beside the checks", async (t) => {
  const f = await fixture((input) => ({
    summary: "1 finding: the relationship overstates a contract.",
    findings: [
      { ref: "$crop-artera", rule: "claim.overstated", severity: "warning", message: "The evidence only shows intent.", fix: "Mark it proposed." },
      // A ref the batch does not have is kept at batch level.
      { ref: "$missing", rule: "node.duplicate", severity: "note", message: `Seen ${input.data.operations.length} operations.`, fix: null },
    ],
  }));
  t.after(() => f.app.dispose());
  const staged = await json(await f.graphql("mutation ($input: StageChangesInput!) { stageChanges(input: $input) { id } }", { input: {
    title: "Our crop project",
    proposals: [
      { operation: node("$crop", 20, core.project, "Lunar greenhouse"), evidence: cite("plan") },
      { operation: edge("$crop-artera", 21, partOf, "$crop", uuid(1)), evidence: cite("plan") },
    ],
  } }));
  const batchId = staged.data.stageChanges.id;
  const submitted = await json(await f.graphql("mutation ($input: SubmitBatchInput!) { submitBatch(input: $input) { state } }", { input: { batchId } }));
  const { state } = submitted.data.submitBatch;
  const { review } = (await f.reviewed(batchId)).batch;
  // A member batch still waits for a member.
  assert.equal(state, "awaiting_review");
  assert.equal(review.state, "complete", review.error ?? undefined);
  assert.deepEqual(review.findings.map((item: Json) => [item.ref, item.rule]), [["$crop-artera", "claim.overstated"], [null, "node.duplicate"]]);
  assert.equal(review.summary, "1 finding: the relationship overstates a contract.");
});

test("a steward that fails leaves the batch unaffected and keeps the built-in checks; a re-review is a new run", async (t) => {
  let fail = true;
  const f = await fixture(() => {
    if (fail) throw new Error("model unavailable");
    return { summary: "Reviewed again.", findings: [] };
  });
  t.after(() => f.app.dispose());
  const batchId = await externalProjectBatch(f);
  await json(await f.action("batch.submit", { batchId }, forerunner));
  const submitted = await f.reviewed(batchId);
  assert.equal(submitted.counts.committed, undefined);
  assert.equal(submitted.batch.review.state, "failed");
  const retry = await f.app.database.prepare("SELECT state, attempts, nextAttemptAt FROM onto_review_jobs WHERE batchId = ?").bind(batchId).first();
  assert.equal(retry?.state, "pending");
  assert.equal(retry?.attempts, 1);
  assert.ok(Number(retry?.nextAttemptAt) > Date.now());
  assert.equal(submitted.batch.review.complete, false);
  assert.ok(submitted.batch.review.findings.some((item: Json) => item.rule === "project.foreign"));

  fail = false;
  const again = await json(await f.page("steward-review", { method: "POST", body: { batchId } }));
  assert.equal(again.batch.review.state, "complete");
  assert.notEqual(again.batch.review.runId, submitted.batch.review.runId);
  assert.equal(f.calls.filter((call) => call.operation === "workflow.start").length, 2);
  // Decisions are untouched by either review.
  assert.equal(again.counts.committed, undefined);
  assert.equal(again.counts.awaiting_review, 4);
  // Only an editor can ask for a review, and an open batch is not reviewed.
  assert.equal((await f.app.call("/api/apps/onto/batches/steward-review", { userId: "member", organizationId: "org", role: "member" } as typeof owner, { method: "POST", body: { batchId } })).status, 403);
  const open = await json(await f.action("batch.open", { title: "Still open" }));
  assert.equal((await f.page("steward-review", { method: "POST", body: { batchId: open.batch.id } })).status, 409);
});

test("a large batch is read in parts that each fit the step cap, and the review says how much it covered", async (t) => {
  const f = await fixture((input) => ({ summary: `Part ${input.data.part.index}: no findings.`, findings: [] }));
  t.after(() => f.app.dispose());
  const { batch } = await json(await f.action("batch.open", { title: "Confluence export" }));
  // 150 pages, each a 3 KB pasted body with a 1.9 KB evidence quote: about ten times the cap.
  const page = (n: number) => ({
    operation: node(`$page-${n}`, 100 + n, core.document, `Page ${n} of the export`, { summary: `What page ${n} says about our platform.`, body: `Page ${n}. ${"Pasted PDF text. ".repeat(190)}` }),
    evidence: [{ provider: "confluence", recordId: `page-${n}`, quote: `Page ${n} ${"quoted text ".repeat(158)}` }],
    reason: `Page ${n} describes a system we run.`,
  });
  const relate = (n: number) => ({ operation: edge(`$page-${n}-of`, 400 + n, core.documents, `$page-${n}`, uuid(1)), evidence: cite(`page-${n}`) });
  for (let start = 0; start < 150; start += 10)
    await json(await f.action("batch.add", { batchId: batch.id, proposals: Array.from({ length: 10 }, (_, i) => page(start + i)) }));
  for (let start = 0; start < 150; start += 50)
    await json(await f.action("batch.add", { batchId: batch.id, proposals: Array.from({ length: 50 }, (_, i) => relate(start + i)) }));
  await json(await f.action("batch.submit", { batchId: batch.id }));
  const { review } = (await f.reviewed(batch.id)).batch;
  assert.equal(review.state, "complete", review.error ?? undefined);

  const inference = f.calls.filter((call) => call.operation === "inference.generate");
  assert.ok(inference.length > 1, `${inference.length} parts`);
  for (const call of inference) assert.ok(JSON.stringify(call.input.data).length <= 64 * 1024, `${JSON.stringify(call.input.data).length} bytes`);
  // Every operation is read once, a node beside its own relationship, with excerpts instead of whole bodies and quotes.
  const refs = inference.flatMap((call) => call.input.data.operations.map((op: Json) => op.ref));
  assert.equal(refs.length, 300);
  assert.equal(new Set(refs).size, 300);
  const first = inference[0].input.data.operations;
  assert.deepEqual(first.slice(0, 2).map((op: Json) => op.ref), ["$page-0", "$page-0-of"]);
  assert.ok(first[0].operation.attributes.body.length <= 601);
  assert.ok(first[0].evidence[0].quote.length <= 201);
  assert.equal(first[0].evidence[0].recordId, "page-0");
  assert.deepEqual(inference[0].input.data.part, { index: 1, of: inference.length, operations: first.length });
  assert.deepEqual(review.coverage, { operations: 300, read: 300, parts: inference.length });
  assert.equal(review.complete, true);
  assert.match(review.summary, new RegExp(`^Read in ${inference.length} parts\\. Part 1: no findings\\.`));
  // One run for the whole review; the built-in checks cover every operation.
  assert.equal(f.calls.filter((call) => call.operation === "workflow.start").length, 1);
  assert.ok(new Set(inference.map((call) => call.input.runId)).size === 1);
  const quotes = review.findings.find((item: Json) => item.rule === "evidence.quote-too-long");
  assert.equal(quotes.refs.length, 100);
  assert.match(quotes.message, /^150 cards/);
});

test("staging returns advice, and the steward reviews the open draft once with a type the agent can stage", async (t) => {
  const f = await fixture((input) => ({
    summary: "1 finding: shots need a type.",
    findings: input.data.batch.state === "open" ? [{
      ref: null, refs: ["$shot-1", "$shot-2", "$shot-3", "$nope"], rule: "type.missing", severity: "warning", message: "Three shots are Documents.", fix: "Stage Shot and shot_of.",
      types: [
        { category: "node", name: "Shot", title: "Shot", body: "One beat of a storyboard.", properties: [{ name: "sequence", type: "number", description: "Order in the storyboard" }], from: [], to: [] },
        { category: "edge", name: "shot_of", title: "Shot of", body: "A shot belongs to its storyboard.", properties: [], from: ["Shot"], to: ["Document"] },
      ],
    }] : [],
  }));
  t.after(() => f.app.dispose());
  const shot = (n: number) => [
    { operation: node(`$shot-${n}`, 30 + n, core.document, `0${n} — Hook — choose a place`, { summary: `Beat ${n} of the teaser.` }), evidence: cite("plan") },
    { operation: edge(`$shot-${n}-of`, 40 + n, partOf, `$shot-${n}`, "$board"), evidence: cite("plan") },
  ];
  const input = { title: "Launch video", proposals: [
    { operation: node("$board", 30, core.document, "Find your spot (15s)", { summary: "The teaser we post at launch." }), evidence: cite("plan") },
    { operation: edge("$board-of", 39, core.documents, "$board", uuid(1)), evidence: cite("plan") },
    ...shot(1), ...shot(2), ...shot(3),
  ] };
  const staged = await json(await f.graphql("mutation ($input: ChangeBatchChangesInput!) { changeBatchChanges(input: $input) { items { key status result } instructions { code required message } } }",
    { input: { items: [{ key: "stage-1", action: "stage", input }] } }));
  const { items, instructions } = staged.data.changeBatchChanges;
  const advice = items[0].result.advice;
  const cluster = advice.find((item: Json) => item.rule === "type.generic-cluster");
  assert.deepEqual(cluster.refs, ["$shot-1", "$shot-2", "$shot-3"]);
  assert.equal(cluster.stage.proposals[0].operation.type, "graph-type");
  assert.deepEqual(instructions.map((item: Json) => [item.code, item.required]), [["CONSIDER_TYPES", false], ["SUBMIT_CHANGES", false]]);
  const batchId = items[0].result.id;

  // The draft is reviewed while open, and its finding carries the type as stageable proposals.
  const { review } = (await f.reviewed(batchId)).batch;
  assert.equal(review.state, "complete", review.error ?? undefined);
  assert.equal(review.stage, "open");
  const missing = review.findings.find((item: Json) => item.rule === "type.missing");
  assert.deepEqual(missing.refs, ["$shot-1", "$shot-2", "$shot-3"]);
  assert.deepEqual(missing.stage.move, ["$shot-1", "$shot-2", "$shot-3"]);
  const [shotType, shotOf] = missing.stage.proposals.map((proposal: Json) => proposal.operation.attributes);
  assert.equal(shotType.name, "Shot");
  assert.deepEqual(shotOf.ontology.endpoints, { from: [shotType.id], to: [core.document] });
  // Agents read it beside the advice before submitting.
  const read = await json(await f.action("graph.graphql", { query: "query ($ids: [ID!]) { changeBatches(ids: $ids) { nodes { review advice } } }", variables: { ids: [batchId] } }));
  assert.equal(read.data.changeBatches.nodes[0].review.runId, review.runId);

  // Restaging the same draft, then submitting it unchanged, reviews nothing again.
  await json(await f.graphql("mutation ($input: StageChangesInput!) { stageChanges(input: $input) { id } }", { input: { batchId, proposals: input.proposals.slice(0, 1) } }));
  await json(await f.graphql("mutation ($input: SubmitBatchInput!) { submitBatch(input: $input) { state } }", { input: { batchId } }));
  const submitted = await f.reviewed(batchId);
  assert.equal(submitted.batch.review.runId, review.runId);
  assert.equal(f.calls.filter((call) => call.operation === "workflow.start").length, 1);
  const jobs = await f.app.database.prepare("SELECT state FROM onto_review_jobs WHERE batchId = ?").bind(batchId).all();
  assert.deepEqual(jobs.results.map((job) => job.state), ["complete"]);
});

test("the steward approves a batch it found clean, recorded as its own decision citing the review run", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const staged = await json(await f.graphql("mutation ($input: StageChangesInput!) { stageChanges(input: $input) { id } }", { input: {
    title: "Our crop project",
    proposals: [
      { operation: node("$crop", 50, core.project, "Lunar greenhouse"), evidence: cite("plan") },
      { operation: edge("$crop-artera", 51, partOf, "$crop", uuid(1)), evidence: cite("plan") },
    ],
  } }));
  const batchId = staged.data.stageChanges.id;
  await json(await f.graphql("mutation ($input: SubmitBatchInput!) { submitBatch(input: $input) { state } }", { input: { batchId } }));
  const read = await f.decided(batchId);
  const { review } = read.batch;
  assert.deepEqual(review.decision.held, []);
  assert.equal(review.decision.approved, 2);
  assert.equal(read.batch.state, "committed");
  for (const op of read.operations) {
    assert.equal(op.state, "committed");
    assert.deepEqual({ ...op.decision, at: 0 }, { kind: "steward", runId: review.runId, prompt: review.prompt.digest, reason: "clean review", at: 0 });
  }
  const decidedBy = await f.app.database.prepare("SELECT decidedBy FROM graph_batch_operations WHERE batchId = ?").bind(batchId).all();
  assert.deepEqual(decidedBy.results.map((row) => row.decidedBy), [null, null]);
  // The record's history names the steward and its run.
  const history = await json(await f.page(`history?id=${uuid(50)}`));
  assert.equal(history.revisions[0].approval.kind, "steward");
  assert.equal(history.revisions[0].approval.runId, review.runId);
});

test("the steward approves only the clean part: flagged and questioned proposals and what needs them wait for a member", async (t) => {
  const f = await fixture(() => ({
    summary: "1 finding: the cultivar may duplicate one we have.",
    findings: [{ ref: "$tomato", refs: [], rule: "node.duplicate", severity: "warning", message: "Probably a duplicate.", fix: null, types: [] },
      { ref: "$crop", refs: [], rule: "claim.overstated", severity: "note", message: "Fine as is.", fix: null, types: [] }],
  }));
  t.after(() => f.app.dispose());
  const { batch } = await json(await f.action("batch.open", { title: "Crops" }));
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [
    { operation: node("$crop", 60, core.project, "Lunar greenhouse"), evidence: cite("plan") },
    { operation: edge("$crop-artera", 61, partOf, "$crop", uuid(1)), evidence: cite("plan") },
    { operation: node("$tomato", 62, core.technology, "Dwarf tomato cultivar"), evidence: cite("veg") },
    { operation: edge("$tomato-crop", 63, partOf, "$tomato", "$crop"), evidence: cite("veg") },
    { operation: node("$lamp", 64, core.technology, "Grow lamp"), evidence: cite("plan") },
    { operation: edge("$lamp-crop", 65, partOf, "$lamp", "$crop"), evidence: cite("plan") },
  ] }));
  await json(await f.action("batch.ask", { batchId: batch.id, questions: [{ key: "lamp-vendor", ask: "Which lamp do we use?", refs: ["$lamp-crop"] }] }));
  await json(await f.action("batch.submit", { batchId: batch.id }));
  const read = await f.decided(batch.id);
  const states = Object.fromEntries(read.operations.map((op: Json) => [op.ref, op.state]));
  // A note holds nothing; the warning holds the cultivar and its relationship; the question holds the lamp's relationship,
  // and the lamp itself, which would not connect without it.
  assert.deepEqual(states, { "$crop": "committed", "$crop-artera": "committed", "$tomato": "awaiting_review", "$tomato-crop": "awaiting_review", "$lamp": "awaiting_review", "$lamp-crop": "awaiting_review" });
  assert.equal(read.batch.state, "awaiting_review");
  assert.deepEqual(Object.fromEntries(read.batch.review.decision.held.map((item: Json) => [item.ref, item.reason])), {
    "$tomato": "node.duplicate", "$tomato-crop": "depends on a held proposal", "$lamp-crop": "question lamp-vendor",
    "$lamp": "does not connect to an anchor without a held proposal",
  });
  assert.equal(read.batch.review.decision.approved, 2);
  // Once a member answers the question, a fresh review approves what it held.
  await json(await f.page("answer", { method: "POST", body: { batchId: batch.id, key: "lamp-vendor", text: "The 400 W lamp." } }));
  const again = await json(await f.page("steward-review", { method: "POST", body: { batchId: batch.id } }));
  const after = Object.fromEntries(again.operations.map((op: Json) => [op.ref, op.state]));
  assert.equal(after["$lamp"], "committed");
  assert.equal(after["$lamp-crop"], "committed");
  assert.equal(after["$tomato"], "awaiting_review");
  // A member still decides the rest, as a member.
  const done = await json(await f.page("review", { method: "POST", body: { batchId: batch.id, verdict: "approve" } }));
  assert.equal(done.batch.state, "committed");
  assert.equal(done.operations.find((op: Json) => op.ref === "$tomato").decision.kind, "member");
});

test("an error on the whole batch approves nothing", async (t) => {
  const f = await fixture(() => ({ summary: "The batch mixes two owners.", findings: [{ ref: null, refs: [], rule: "owner.unreachable", severity: "error", message: "Mixed.", fix: null, types: [] }] }));
  t.after(() => f.app.dispose());
  const staged = await json(await f.graphql("mutation ($input: StageChangesInput!) { stageChanges(input: $input) { id } }", { input: {
    title: "Our crop project",
    proposals: [
      { operation: node("$crop", 70, core.project, "Lunar greenhouse"), evidence: cite("plan") },
      { operation: edge("$crop-artera", 71, partOf, "$crop", uuid(1)), evidence: cite("plan") },
    ],
  } }));
  const batchId = staged.data.stageChanges.id;
  await json(await f.graphql("mutation ($input: SubmitBatchInput!) { submitBatch(input: $input) { state } }", { input: { batchId } }));
  const read = await f.decided(batchId);
  assert.equal(read.batch.review.decision.approved, 0);
  assert.deepEqual(read.batch.review.decision.held.map((item: Json) => item.reason), ["owner.unreachable on the whole batch", "owner.unreachable on the whole batch"]);
  assert.equal(read.counts.awaiting_review, 2);
});

test("submitting names the steward's review run to wait on, and that run is the one the review starts", async (t) => {
  // The steward answers only once the receipt has been read.
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(async () => { await gate; return { summary: "No findings.", findings: [] }; });
  t.after(() => { release(); return f.app.dispose(); });
  const { batch } = await json(await f.action("batch.open", { title: "Crops" }));
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [
    { operation: node("$crop", 80, core.project, "Lunar greenhouse"), evidence: cite("plan") },
    { operation: edge("$crop-artera", 81, partOf, "$crop", uuid(1)), evidence: cite("plan") },
  ] }));
  const submitted = await json(await f.graphql("mutation ($input: ChangeBatchChangesInput!) { changeBatchChanges(input: $input) { items { key status result } instructions { code actor required taskId message } } }",
    { input: { items: [{ key: "submit-1", action: "submit", input: { batchId: batch.id } }] } }));
  const { items, instructions } = submitted.data.changeBatchChanges;
  const run = items[0].result.reviewRun;
  assert.ok(["pending", "running"].includes(run.state));
  assert.match(run.runId, /^[0-9a-f-]{36}$/);
  const wait = instructions.find((item: Json) => item.code === "WAIT_FOR_RUN");
  assert.equal(wait.taskId, run.runId);
  assert.equal(wait.required, true);
  assert.match(wait.message, /approves what it found clean/);
  // The review starts exactly that run; once it finishes the batch no longer names one.
  release();
  const done = await f.decided(batch.id);
  assert.equal(done.batch.review.runId, run.runId);
  assert.equal(f.calls.find((call) => call.operation === "workflow.start")!.input.id, run.runId);
  const read = await json(await f.action("graph.graphql", { query: "query ($id: ID!) { changeBatch(id: $id) { reviewRun instructions { code } } }", variables: { id: batch.id } }));
  assert.equal(read.data.changeBatch.reviewRun, null);
  assert.ok(!read.data.changeBatch.instructions.some((item: Json) => item.code === "WAIT_FOR_RUN"));
});

test("an admin can keep every decision with members: the steward then only reviews", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const settings = await json(await f.action("graph.graphql", { query: "query { settings { stewardApproval } }", variables: {} }));
  assert.equal(settings.data.settings.stewardApproval, "approve");
  // A member without admin access cannot change it.
  const member = { userId: "member", organizationId: "org", role: "member" };
  const refused = await f.app.call("/api/apps/onto/settings", member as typeof owner, { method: "POST", body: { stewardApproval: "review" } });
  assert.equal(refused.status, 403);
  const saved = await json(await f.graphql("mutation ($input: SaveSettingsInput!) { saveSettings(input: $input) { stewardApproval updatedBy } }", { input: { stewardApproval: "review" } }));
  assert.deepEqual(saved.data.saveSettings, { stewardApproval: "review", updatedBy: "owner" });

  const { batch } = await json(await f.action("batch.open", { title: "Crops" }));
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [
    { operation: node("$crop", 90, core.project, "Lunar greenhouse"), evidence: cite("plan") },
    { operation: edge("$crop-artera", 91, partOf, "$crop", uuid(1)), evidence: cite("plan") },
  ] }));
  await json(await f.action("batch.submit", { batchId: batch.id }));
  const read = await f.reviewed(batch.id);
  assert.equal(read.batch.review.state, "complete");
  assert.equal(read.batch.review.decision, undefined);
  assert.equal(read.counts.awaiting_review, 2);
  const page = await json(await f.app.call("/api/apps/onto/settings", owner, {}));
  assert.equal(page.stewardApproval, "review");
});

test("scoped Calendar evidence holds the duplicate and its dependent even before the model reviews it", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.action("graph.apply", { requestKey: "organization-profile", operations: [
    { operation: "update", ref: "$profile", type: "graph-node", id: uuid(1), revision: 1,
      attributes: { website: "https://outfitter.ncrmro.com/o/artera" } },
  ] }));
  const { batch } = await json(await f.action("batch.open", { title: "Calendar discovery", policy: {kind:"confidence", threshold:0.95, version:"test", reviewWindow:{hours:1}}, anchors:[] }, forerunner));
  const evidence = [{provider:"google-calendar",recordId:"fixture@artera.space/event-id"}];
  await json(await f.action("batch.add", {batchId:batch.id, proposals:[
    {operation:node("$candidate",84,core.organization,"Artera Space"),evidence,confidence:0.99},
    {operation:edge("$relationship",85,partOf,"$candidate",uuid(1)),evidence,confidence:0.99},
    {operation:node("$unrelated",86,core.document,"Independent note"),evidence,confidence:0.99},
  ]},forerunner));
  const submitted = await json(await f.action("batch.submit", {batchId:batch.id},forerunner));
  assert.deepEqual(submitted.operations.map((op:Json)=>op.state),["awaiting_review","awaiting_review","committed"]);
  await f.reviewed(batch.id);
  const {batch:saved} = await json(await f.action("batch.get",{batchId:batch.id}));
  const duplicate = saved.review.findings.find((i:Json)=>i.rule==="node.duplicate");
  assert.equal(duplicate.ref,"$candidate");
  assert.deepEqual(duplicate.organizationCandidates,[{id:uuid(1),title:"Artera",slug:"artera",match:"organization name corroborated by scoped account domain artera.space"}]);
  assert.ok(duplicate.fix.includes(uuid(1)));
  const input=f.calls.find(c=>c.operation==="inference.generate")!.input;
  assert.deepEqual(input.data.checks.find((c:Json)=>c.rule==="node.duplicate").organizationCandidates,duplicate.organizationCandidates);
  assert.equal(saved.review.decision.approved,0);
  const who = { ...owner, installationId: f.app.installationId, owner: { kind: "organization" as const, id: "org" }, canEdit: true };
  assert.equal((await sealDueBatches(drizzle(f.app.database), who, Date.now() + 2 * 3600_000)).sealed, 0);
  const graph=await json(await f.action("graph.read",{}));
  assert.equal(graph.nodes.some((n:Json)=>n.id===uuid(84)),false);
  assert.equal(graph.edges.some((e:Json)=>e.id===uuid(85)),false);
});

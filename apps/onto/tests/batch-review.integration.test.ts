import assert from "node:assert/strict";
import test from "node:test";
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
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"), "wiki-map-installation", {
    workflowHost: () => ({ call: async (operation, input) => {
      const body = input as Json;
      calls.push({ operation, input: body });
      try {
        if (operation === "workflow.start") return { ok: true, value: { id: body.id, workflow: body.workflow, created: true } };
        if (operation === "inference.generate") return { ok: true, value: { output: answer(body) } };
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
    app.call(`/api/apps/wiki-map/batches/${path}`, owner as typeof owner, { ...init, workflowHost: scope });
  /** The batch once its background review has been saved. */
  const reviewed = async (batchId: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const read = await json(await action("batch.get", { batchId }));
      if (read.batch.review) return read;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("The review was not saved");
  };
  return { app, calls, action, graphql, page, reviewed };
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

test("a batch adding an external Project gets an error finding, and its policy commits exactly as before", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const batchId = await externalProjectBatch(f);
  const submitted = await json(await f.action("batch.submit", { batchId, summary: "Space crop research" }, forerunner));

  // Commit behavior is unchanged: the confident operations commit by policy, the rest wait for a member.
  assert.deepEqual(submitted.operations.map((op: Json) => [op.ref, op.state]),
    [["$nasa", "committed"], ["$veg", "committed"], ["$veg-nasa", "committed"], ["$tomato", "awaiting_review"]]);
  assert.equal(submitted.batch.state, "awaiting_review");
  // Submitting does not wait for the review; it is saved in the background.
  assert.equal(submitted.batch.review, null);

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
  const [{ slug }] = (await f.app.database.prepare("SELECT slug FROM graph_batches WHERE id = ?").bind(batchId).all()).results as { slug: string }[];
  const read = await json(await f.action("graph.graphql", { query: "query ($slug: String!) { changeBatch(slug: $slug) { review } }", variables: { slug } }));
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
  const staged = await json(await f.graphql("mutation ($input: StageChangesInput!) { stageChanges(input: $input) { id slug } }", { input: {
    title: "Our crop project",
    proposals: [
      { operation: node("$crop", 20, core.project, "Lunar greenhouse"), evidence: cite("plan") },
      { operation: edge("$crop-artera", 21, partOf, "$crop", uuid(1)), evidence: cite("plan") },
    ],
  } }));
  const batchId = staged.data.stageChanges.id;
  const submitted = await json(await f.graphql("mutation ($input: SubmitBatchInput!) { submitBatch(input: $input) { state } }", { input: { batch: staged.data.stageChanges.slug } }));
  const { state } = submitted.data.submitBatch;
  const { review } = (await f.reviewed(batchId)).batch;
  // A member batch still waits for a member.
  assert.equal(state, "awaiting_review");
  assert.equal(review.state, "complete");
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
  assert.equal(submitted.counts.committed, 3);
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
  assert.equal(again.counts.committed, 3);
  assert.equal(again.counts.awaiting_review, 1);
  // Only an editor can ask for a review, and an open batch is not reviewed.
  assert.equal((await f.app.call("/api/apps/wiki-map/batches/steward-review", { userId: "member", organizationId: "org", role: "member" } as typeof owner, { method: "POST", body: { batchId } })).status, 403);
  const open = await json(await f.action("batch.open", { title: "Still open" }));
  assert.equal((await f.page("steward-review", { method: "POST", body: { batchId: open.batch.id } })).status, 409);
});

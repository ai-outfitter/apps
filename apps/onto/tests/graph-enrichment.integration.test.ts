import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";

const who = { userId: "owner", organizationId: "org", role: "owner" };
const query = "mutation EnrichGraph($prompt:String){enrichGraph(prompt:$prompt)}";
const product = "34000000-0000-4000-8000-000000000001", org = "34000000-0000-4000-8000-000000000002";
type Json = Record<string, any>;
const quote = "Solar Labs develops Helio. Solar Labs offers the Solar Hosting service.";

test("an installed default schedule and a prompted MCP mutation share enrichment and submit sourced, connected batches", async t => {
  const receipts: Json[] = [], saved: Json[] = [], readThreads: string[] = [];
  const threadId = crypto.randomUUID();
  const history = { id: threadId, ref: { id: threadId }, title: "Recently completed Helio review", type: "onto.agent", typeVersion: 1,
    context: { type: "onto.node", id: product }, parent: null, owner: { kind: "organization", id: "org" }, installationId: "onto",
    createdBy: "owner", visibility: "organization", working: false, pinned: false, readOnly: false, status: "archived", updatedAt: Date.now(), createdAt: 1 };
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "onto", {
    workflowHost: () => ({ call: async (op, raw) => {
      const input = raw as Json;
      const ok = (value: unknown) => ({ ok: true as const, value });
      if (op === "schedules") return ok(saved);
      if (op === "schedule.save") {
        const item = { ...input, id: "daily", workflowId: input.workflow, cron: "0 9 * * *", connectionId: null, resource: null,
          createdBy: "owner", nextRunAt: Date.now()+86400000, lastRunAt: null, lastRunId: null, lastOutcome: null };
        saved.push(item); return ok(item);
      }
      if (op === "threads.list") return ok({ threads: [history, { ...history, ref: { id: crypto.randomUUID() }, id: "private", visibility: "private" },
        { ...history, ref: { id: crypto.randomUUID() }, id: "other", owner: { kind: "organization", id: "other" } }], cursor: null });
      if (op === "threads.entries") { readThreads.push(input.ref.id); return ok({ entries: [], before: null, after: null }); }
      if (op === "web.search") {
        assert.equal(input.query, "site:solar.example.org provider products offerings official");
        return ok({ results: [{ title: "Solar Labs catalog", url: "https://solar.example.org/products", snippet: quote }] });
      }
      if (op === "workflow.start") return ok({ id: input.id, workflow: input.workflow, created: true });
      if (op === "workflow.collect") { receipts.push(input.value); return ok({ run: "complete", steps: { explore: "complete" } }); }
      if (op === "inference.generate") {
        if (input.data.claims) return ok({ output: { supported: [0] } });
        const company = { type: "Organization", title: "Solar Labs" };
        const fact = input.data.anchor.title === "Helio"
          ? { from: { type: "Product", title: "Helio" }, relationship: "developed_by", to: company, quote: "Solar Labs develops Helio." }
          : { from: { type: "Offering", title: "Solar Hosting" }, relationship: "offered_by", to: company, quote: "Solar Labs offers the Solar Hosting service." };
        return ok({ output: { facts: [{ ...fact, source: 0 }, { ...fact, quote: "An invented quote which is not in the source", source: 0 }] } });
      }
      return { ok: false, status: 503, message: "Test host omits " + op };
    } }),
  });
  t.after(() => app.dispose());
  const scope = { organizationId: "org", installationId: "onto", userId: "owner", packageHash: "fixture", phase: "interactive" as const, expiresAt: Date.now() + 600000 };
  const read = async (response: Response) => {
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text);
    assert.ok(!body.errors, JSON.stringify(body.errors));
    return body;
  };
  const initialize = async () => read(await app.call("/api/internal/app-initialize", who, { method: "POST", body: {}, workflowHost: scope }));
  const action = async (name: string, input: object) => read(await app.call("/api/internal/actions/v1/call", who, {
    method: "POST", body: { action: name, input }, workflowHost: scope,
  }));
  const scheduled = async () => read(await app.call("/api/internal/workflow-host/v1", who, { method: "POST",
    workflowHost: { ...scope, phase: "schedule", scheduleId: "daily" },
    body: { phase: "schedule", input: { schedule: { ...saved[0], inputs: {} }, runId: crypto.randomUUID(), scheduledFor: Date.now() } },
  }));
  assert.equal((await initialize()).enrichmentSchedule, "saved");
  assert.equal((await initialize()).enrichmentSchedule, "kept");
  const graph = await action("graph.read", {});
  const typeId = (name: string) => graph.types.find((type: Json) => type.name === name).id;
  const seed = (id: string, type: string, title: string) => ({ ref: "$" + type, operation: "create", type: "graph-node",
    attributes: { id, title, typeId: typeId(type), body: "Primary catalog: https://solar.example.org/products" } });
  await action("graph.apply", { requestKey: "setup", operations: [seed(product, "Product", "Helio"), seed(org, "Organization", "Solar Labs")] });
  await scheduled();
  const first = receipts.at(-1)!;
  assert.equal(first.state, "awaiting_review");
  const initial = await action("batch.get", { batchId: first.batchId });
  assert.equal(initial.operations.length, 1);
  assert.equal(initial.operations[0].operation.attributes.toId, org);
  assert.equal(initial.operations[0].evidence[0].uri, "https://solar.example.org/products");
  await scheduled();
  assert.equal(receipts.at(-1)!.batchId, first.batchId);
  assert.equal(receipts.at(-1)!.state, "pending");

  // An independent prompted gap can be explored when the provider edge is already canonical.
  await action("graph.mutate", { query: "mutation($input:ReviewBatchInput!){reviewBatch(input:$input){id}}",
      variables: { input: { batchId: first.batchId, verdict: "approve" } } });
  const prompted = await action("graph.mutate", { query, operationName: "EnrichGraph", variables: { prompt: "Expand the offerings of Solar Labs." } });
  assert.equal(prompted.data.enrichGraph.state, "awaiting_review");
  const second = await action("batch.get", { batchId: prompted.data.enrichGraph.batchId });
  assert.deepEqual(second.operations.map((op: Json) => op.operation.type).sort(), ["graph-edge", "graph-node"]);
  assert.ok(second.operations.every((op: Json) => op.evidence[0].quote === "Solar Labs offers the Solar Hosting service."));
  assert.ok(readThreads.every(id => id === threadId));
});

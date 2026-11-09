import assert from "node:assert/strict";
import test from "node:test";
import { identityHeaderValues } from "@ai-outfitter/app-sdk/server";
import { type WorkflowHostResult, type WorkflowHostScope, workflowHostPath } from "@ai-outfitter/app-sdk/workflow-host";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { core } from "../src/lib/graph";
import { create, definitions } from "./fixtures/relators";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
// Forerunner calling the Wiki, as platform dispatch forwards it.
const app = { ...owner, actor: { kind: "app" as const, id: "forerunner" } };
const installationId = "wiki";
const scope = (phase: WorkflowHostScope["phase"], extra: Partial<WorkflowHostScope> = {}): WorkflowHostScope =>
  ({ organizationId: "org", installationId, userId: "owner", packageHash: "hash", phase, expiresAt: Date.now() + 60_000, ...extra });
const service = identityHeaderValues({ userId: "invocation:seal", organizationId: "org", installationId, role: "service" });

// biome-ignore lint/suspicious/noExplicitAny: public JSON responses under test.
async function json(response: Response): Promise<Record<string, any>> {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function fixture() {
  const saved: Record<string, unknown>[] = [];
  const answer = (operation: string, input: Record<string, unknown>): WorkflowHostResult => {
    if (operation === "invocations") return { ok: true, value: saved.map((row) => ({ id: "seal", name: row.name, intervalMinutes: 60, enabled: true, enabledBy: "installation:wiki", nextRunAt: 1, lastRunAt: null, lastOutcome: null })) };
    if (operation === "invocation.save") {
      saved.push(input);
      return { ok: true, value: { id: "seal", name: input.name, intervalMinutes: 60, enabled: true, enabledBy: "installation:wiki", nextRunAt: 1, lastRunAt: null, lastOutcome: null } };
    }
    return { ok: false, status: 403, message: `Unexpected ${operation}` };
  };
  const worker = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), installationId, {
    workflowHost: () => ({ call: async (operation, input) => answer(operation, input as Record<string, unknown>) }),
  });
  const post = (path: string, body: unknown, headers: Record<string, string>, phase: WorkflowHostScope) =>
    worker.dispatch("", new Request(`${worker.origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), { workflowHost: phase });
  const initialize = () => post("/api/internal/app-initialize", {}, identityHeaderValues({ ...owner, installationId }), scope("interactive"));
  const seal = (name = "batches.seal", scheduledFor = Date.now()) => post(workflowHostPath,
    { phase: "invocation", input: { invocation: { id: "seal", name }, scheduledFor } }, service,
    scope("invocation", { invocationId: "seal", userId: "invocation:seal" }));
  const action = (name: string, input: object, identity: object = owner) =>
    worker.call("/api/internal/actions/v1/call", identity as typeof owner, { method: "POST", body: { action: name, input } });
  return { worker, saved, initialize, seal, action };
}

test("every activation keeps one hourly, installation-owned seal timer", async (t) => {
  const f = await fixture();
  t.after(() => f.worker.dispose());
  assert.equal((await json(await f.initialize())).sealTimer, "saved");
  assert.equal((await json(await f.initialize())).sealTimer, "kept");
  assert.deepEqual(f.saved, [{ name: "batches.seal", owner: "installation", intervalMinutes: 60, enabled: true }]);
});

test("the hourly seal approves what is past its window, by policy and as no member", async (t) => {
  const f = await fixture();
  t.after(() => f.worker.dispose());
  await json(await f.action("graph.apply", { requestKey: "definitions", operations: definitions() }));
  const policy = { kind: "confidence", threshold: 0.95, version: "test", reviewWindow: { hours: 1 } };
  const { batch } = await json(await f.action("batch.open", { title: "Daily", source: { kind: "discovery-run", ref: "r" }, policy }, app));
  const id = "7c0e0000-0000-4000-8000-000000000001";
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [{ operation: create("$cy", "graph-node", { id, typeId: core.person, title: "Cy" }), confidence: 0.6 }] }, app));
  await json(await f.action("batch.submit", { batchId: batch.id }, app));

  // Not due yet: nothing seals.
  assert.match((await json(await f.seal())).summary, /^sealed 0/);
  assert.equal((await json(await f.action("batch.get", { batchId: batch.id }))).batch.state, "awaiting_review");

  // Two hours on, the window has closed.
  assert.match((await json(await f.seal("batches.seal", Date.now() + 2 * 3600_000))).summary, /^sealed 1/);
  const sealed = await json(await f.action("batch.get", { batchId: batch.id }));
  assert.equal(sealed.batch.state, "committed");
  assert.equal(sealed.operations[0].decision.reason, "review-window");
  const history = await json(await f.worker.call(`/api/apps/wiki-map/batches/history?id=${id}`, owner));
  assert.equal(history.revisions[0].approval.kind, "policy");

  assert.equal((await json(await f.seal("something.else"))).outcome, "declined");
});

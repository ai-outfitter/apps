import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { operations, workflowHostPath, type WorkflowHostResult } from "@ai-outfitter/app-sdk/workflow-host";
import fixture from "../src/workflow-fixture";

const runId = "11111111-1111-4111-8111-111111111111";
const run = { id: runId, workflowId: "flow", status: "running", createdBy: "owner", createdAt: 1, updatedAt: 1 };
const artifact = { id: "artifact", runId, name: "demo.png", contentType: "image/png", revision: null, url: "https://example.test/demo.png", createdAt: 1 };
const entity = { ref: { installationId: "provider", type: "record", id: "record" }, revision: 1, title: "Fixture", attributes: { title: "Fixture" }, references: [] };
const workMarkdown = "# Fixture work\n\nRead-only assigned work context.";
const workContext = {
  rendererVersion: 1, mediaType: "text/markdown", markdown: workMarkdown,
  digest: createHash("sha256").update(workMarkdown).digest("hex"),
  sources: [{ ref: entity.ref, revision: entity.revision }],
  complete: true, omitted: [], unresolved: [],
};
// Contract-valid answers, so the SDK's output validation runs on every call.
const answers: Record<string, unknown> = {
  "entities.types": [{ installationId: "provider", type: "record", title: "Record", description: "Fixture records", schema: { type: "object" }, writable: true }],
  "entities.list": [entity],
  "entities.get": entity,
  "entities.create": entity,
  "entities.update": { ...entity, revision: 2, title: "Updated", attributes: { title: "Updated" } },
  "graph.documents": { appDocuments: [], documents: [] },
  "graph.graphql": { data: {} },
  "actions.list": [{ installationId: "provider", actions: [{ name: "record.touch", description: "Touch a record", access: "write", permitted: true, input: { type: "object" }, output: { type: "object" } }] }],
  "actions.call": { touched: true },
  "graph.mutate": { data: {} },
  "identity.current": { id: "owner", name: "Fixture Owner", email: "owner@example.test" },
  "identity.resolve": { holderId: "holder", kind: "agent", principalId: "fixture-principal" },
  "identity.list": [{ id: "identity", holderId: "holder", kind: "agent", principalId: "fixture-principal" }],
  "identity.link": { linked: true },
  "identity.unlink": { removed: true },
  snapshot: { installation: { id: "app", activeHash: "hash", hostname: "app.example", workflows: [] }, bindings: [], subscriptions: [], connections: [] },
  "workflow.read": { run, inputs: {}, outputs: {}, readiness: { run: "running", steps: {} }, attempts: [] },
  "workflow.start": { id: runId, workflow: "flow", created: true },
  "session.append": { id: "fixture.checkpoint" },
  "session.read": {
    format: "outfitter-workflow-session-v1", exportedAt: "2026-01-01T00:00:00.000Z",
    run: { id: runId, workflowId: "flow", createdBy: "member", installationId: null, organizationId: null, trigger: "manual", status: "running", createdAt: 1, updatedAt: 1, definition: {}, definitionHash: "hash", packageHash: null },
    inputs: {}, outputs: {}, attempts: [], entries: [], gaps: [],
  },
  "task.start": { id: "66666666-6666-4666-8666-666666666666", task: "fixture-task", created: true },
  "workflow.active": [],
  "workflow.activity": { total: 1, items: [{ ...run, inputs: {} }] },
  "workflow.pending": [],
  "workflow.references": [],
  "workflow.collect": { run: "complete", steps: { work: "done" } },
  "connector.execute": { ok: true },
  "connector.receipts": [],
  "repository.read": { name: "acme/widgets", path: "/repos/acme/widgets", repositoryId: 1, installationId: 101, appId: 42 },
  "repository.request": { ok: true },
  "workspace.control": { ok: true },
  "binding.approve": { id: "binding", revision: "one", reused: false },
  "subscription.save": { id: "subscription" },
  "inference.generate": { output: { label: "bug" } },
  "inference.image": { contentType: "image/png", base64: "iVBORw0KGgo=", model: "image-model" },
  "schedule.save": { id: "schedule", workflowId: "flow", cron: "0 9 * * 1-5", timezone: "UTC", inputs: {}, connectionId: null, resource: null, createdBy: "owner",
    enabled: true, nextRunAt: 1, lastRunAt: null, lastRunId: null, lastOutcome: null },
  schedules: [],
  "routines.list": { routines: [], runs: [] },
  "routines.update": { id: "routine", workflowId: "flow", name: "Fixture routine", cadence: "Every day at 09:00 UTC", timezone: "UTC", enabled: false,
    nextRunAt: null, lastRunId: null, lastRunStatus: null, lastOutcome: null, task: null },
  "routines.create": { routine: { id: "routine", workflowId: "recurring-task", name: "Fixture task", cadence: "Weekdays at 08:00 UTC", timezone: "UTC", enabled: true,
    nextRunAt: 1, lastRunId: runId, lastRunStatus: "running", lastOutcome: "started", task: { title: "Fixture task", description: "Do the fixture task." } }, runId },
  "platform.document": { schedules: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } },
  "resident.runtimes": { runtimes: [] },
  "resident.inspect": { status: "offline", message: "Fixture offline" },
  "resident.reconcile": { status: "provisioning", message: "Fixture provisioning" },
  "resident.task-authority": { permitted: true },
  "agent-task.inspect": { revision: "v1", model: "model", profileDigest: "a".repeat(64) },
  "agent-task.send": { taskId: "task", state: "submitted" },
  "agent-task.status": { state: "working" },
  "agent-task.cancel": { state: "canceled", canceled: true },
  "agent-work.providers": { principalId: "resident:fixture:resident", providers: [{ installationId: "provider", permitted: true }] },
  "agent-work.list": { principalId: "resident:fixture:resident", result: { work: [] } },
  "agent-work.context": { principalId: "resident:fixture:resident", result: workContext },
  "invocation.save": { id: "invocation", name: "fixture.tick", intervalMinutes: 15, enabled: true, enabledBy: "owner", nextRunAt: 1, lastRunAt: null, lastOutcome: null },
  invocations: [],
  "artifacts.publish": artifact,
  "artifacts.published": [artifact],
  "artifacts.describe": [],
  "threads.types": [],
  "threads.list": { threads: [], cursor: null },
  "threads.get": null,
  "threads.entries": { entries: [], before: null, after: null },
  "threads.create": { ref: { id: "66666666-6666-4666-8666-666666666666" }, id: "66666666-6666-4666-8666-666666666666", owner: { kind: "organization", id: "org" }, installationId: "app", createdBy: "owner", visibility: "private", type: "fixture.conversation", typeVersion: 1, title: "Fixture", status: "active", context: null, parent: null, pinned: false, working: false, readOnly: false, createdAt: 1, updatedAt: 1 },
  "threads.update": { ref: { id: "66666666-6666-4666-8666-666666666666" }, id: "66666666-6666-4666-8666-666666666666", owner: { kind: "organization", id: "org" }, installationId: "app", createdBy: "owner", visibility: "private", type: "fixture.conversation", typeVersion: 1, title: "Fixture", status: "active", context: null, parent: null, pinned: false, working: false, readOnly: false, createdAt: 1, updatedAt: 1 },
  "threads.append": { id: "entry", thread: { id: "66666666-6666-4666-8666-666666666666" }, role: "event", parts: [{ type: "status", status: "ok" }], status: "complete", submissionId: null, sourceKey: "fixture:1",
    attribution: { actor: { kind: "app", id: "app" }, origin: { kind: "member", id: "owner" }, userId: "owner", installationId: "app" }, metadata: null, createdAt: 1, recordedAt: null },
  "threads.send": { threadId: "66666666-6666-4666-8666-666666666666", submissionId: "77777777-7777-4777-8777-777777777777", state: "running", replyEntryIds: [] },
  "threads.submission": null,
  "threads.cancel": { canceled: false },
  "threads.delete": { deleted: true, detachedChildren: 0 },
  "profile.read": { member: { about: {}, goals: [] }, work: null },
  "profile.update": { member: { about: {}, goals: [{ id: "goal", text: "Ship the fixture", horizon: null, done: false, routineIds: [] }] } },
  "profile.work": { status: "pending" },
  "organization.context": { organization: { id: "org", name: "Fixture", instructions: "", operational: true } },
  "projects.list": { projects: [] },
  "projects.get": null,
  "connectors.google": { available: [], connections: [] },
  "connectors.google.messages": { messages: [] },
  "connectors.google.message": { id: "fixture-message", date: "", from: "", subject: "", snippet: "", to: "", labels: [], text: "" },
  "connectors.google.events": { events: [] },
  "connectors.github.tools": { repositories: [], tools: [] },
  "connectors.github.call": { output: "Refused: GitHub is not connected for these repositories." },
  "workflows.proposal": { guidance: "", categories: [] },
  "workflows.validate": { valid: false, errors: ["A workflow needs 1 to 12 steps"] },
  "catalog.apps": { apps: [], prompt: "" },
  "inference.effort": { effort: false },
};

function host() {
  const calls: { operation: string; input: unknown }[] = [];
  const workflowHost = {
    async call(operation: string, input: unknown): Promise<WorkflowHostResult> {
      calls.push({ operation, input });
      return { ok: true, value: answers[operation] };
    },
  };
  return { calls, context: { props: { workflowHost } } };
}
const phase = (name: string, input: Record<string, unknown>, context: object) =>
  fixture.fetch(new Request(`https://app.example${workflowHostPath}`, {
    method: "POST", body: JSON.stringify({ phase: name, input }),
  }), {}, context);

test("the fixture implements every phase and calls every exported operation", async () => {
  const { calls, context } = host();
  const attemptId = "22222222-2222-4222-8222-222222222222";
  const node = { runId, nodeId: "work", attemptId };
  const event = { action: "opened", issue: { number: 3 } };
  const inputs: Record<string, Record<string, unknown>> = {
    event: {
      runId, deliveryId: "delivery", subscription: { id: "subscription", workflowId: "flow", inputs: {} },
      trigger: { input: "work.inputs.event" }, event: { type: "github.issue", resource: "1", subject: "3", payload: event },
    },
    operator: {
      bindingId: "binding", slot: "work.inputs.payload", key: "key", workflow: "flow", runId, changedInputs: {},
      configure: { workflow: "flow", actor: "worker", workspace: {}, context: {}, connectionId: "github", resource: "1", inputs: {} },
    },
    interactive: { runId, bindingId: "binding", connectionId: "github" },
    schedule: { runId, scheduledFor: 1, schedule: { id: "schedule", workflowId: "flow", inputs: {}, connectionId: null, resource: null } },
    publish: { png: "cG5n", runId },
    prepare: { node, inputs: { event }, outputs: {}, settings: {} },
    finalize: { node, inputs: { event }, outputs: { result: { ready: true, summary: "Done" } }, coordinator: false, session: {}, settings: {} },
    invocation: { invocation: { id: "invocation", name: "fixture.tick" }, scheduledFor: 1 },
  };
  for (const [name, input] of Object.entries(inputs)) {
    const response = await phase(name, input, context);
    assert.equal(response.status, 200, name);
    if (name === "interactive") {
      const result = await response.json() as { agentWorkContext: unknown };
      assert.deepEqual(result.agentWorkContext, { ok: true, value: answers["agent-work.context"] });
    }
  }
  assert.deepEqual([...new Set(calls.map((call) => call.operation))].sort(), Object.keys(operations).sort());
  assert.deepEqual(calls.find(call => call.operation === "agent-work.context")?.input, {
    delegation: "00000000-0000-4000-8000-0000000000a1", installationId: "provider", id: "fixture-work", revision: 1,
  }, "context reads retain the explicit delegation, installation and assigned item revision");
  assert.deepEqual(calls.find((call) => call.operation === "workflow.start")?.input,
    { workflow: "flow", id: runId, inputs: { "work.inputs.event": event } }, "starts the reserved run with the delivered payload");
  assert.deepEqual(calls.find((call) => call.operation === "repository.request" && (call.input as { method?: string }).method === "POST" &&
    (call.input as { path: string }).path.includes("comments"))?.input,
    { method: "POST", path: "/repos/acme/widgets/issues/3/comments", body: { body: "Done" } }, "finalize reads the node's own inputs");
});

test("platform phases answer the explicit result shapes", async () => {
  const { context } = host();
  const declined = await phase("event", {
    runId, deliveryId: "delivery", subscription: { id: "subscription", workflowId: "flow", inputs: {} },
    trigger: { input: "work.inputs.event" }, event: { type: "github.issue", resource: "1", subject: "3", payload: { decline: true } },
  }, context);
  assert.deepEqual(await declined.json(), { outcome: "declined", reason: "Fixture declined the delivery" });
  const node = { runId, nodeId: "work", attemptId: "22222222-2222-4222-8222-222222222222" };
  const prepared = await phase("prepare", { node, inputs: {}, outputs: {}, settings: { previewUrl: "https://pr-1.example.dev" } }, context);
  assert.deepEqual(((await prepared.json()) as { preview?: unknown }).preview, { url: "https://pr-1.example.dev", revision: "b".repeat(40) });
  const coordinated = await phase("prepare", { node, inputs: {}, outputs: {}, settings: { coordinate: true } }, context);
  assert.deepEqual(await coordinated.json(), { mode: "coordinator" });
  // The finalize payload names the node's inputs explicitly; a bag of transport context is refused.
  const contextual = await phase("finalize", { context: { inputs: { event: { issue: { number: 3 } } } }, outputs: {} }, context);
  assert.equal(contextual.status, 502);
});

test("without trusted props the fixture has no host, whatever the request claims", async () => {
  const response = await phase("operator", {}, {});
  assert.equal(response.status, 503);
  const { context } = host();
  assert.equal((await phase("deploy", {}, context)).status, 400, "unknown phase");
  assert.equal((await fixture.fetch(new Request(`https://app.example${workflowHostPath}`), {}, context)).status, 405);
});


test("delegated context refusal remains an observable host failure", async () => {
  const { calls, context } = host();
  const delegate = context.props.workflowHost.call;
  context.props.workflowHost.call = async (operation, input) => {
    if (operation === "agent-work.context") {
      calls.push({ operation, input });
      return { ok: false, status: 403, message: "Delegation refused" };
    }
    return delegate(operation, input);
  };
  const response = await phase("interactive", { runId, bindingId: "binding", connectionId: "github" }, context);
  assert.equal(response.status, 200);
  const result = await response.json() as { agentWorkContext: unknown };
  assert.deepEqual(result.agentWorkContext, { ok: false, status: 403 });
});

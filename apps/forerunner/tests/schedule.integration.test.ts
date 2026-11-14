import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { wikiGraphFixture } from "@ai-outfitter/app-test/wiki-fixture";
import { missingRunInputs, slotIssue, slotKind } from "@ai-outfitter/workflow-core/engine";
import { readWorkflowFile } from "@ai-outfitter/workflow-core/files";
import { Workflow } from "@ai-outfitter/workflow-core/schema";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { getPreview } from "../src/server/discovery";
import { changeSchedule, defaultSchedule, scheduledDiscovery } from "../src/server/schedule";

const types = ["Person", "interacts_with"].map((name, i) => ({ id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, name, category: i ? "edge" : "node", body: `A ${name}.` }));
const who: AppIdentity = { installationId: "forerunner", userId: "alice", owner: { kind: "user", id: "alice" }, role: "owner", canEdit: true };
const connection = { id: "c0000000-0000-4000-8000-000000000001", provider: "gmail", resource: "alice@example.test", label: "Alice", operations: ["messages.list", "messages.get"] };
const semantic = (confidence: number) => ({
  entities: [{ key: "bob", name: "Bob", type: "Person", summary: "Wrote about the draft.", existingId: null, certainty: "mentioned", confidence, evidence: ["e0"] }],
  relationships: [],
});

type Call = (input: Record<string, unknown>) => unknown;
function wikiAction(input: Record<string, unknown>, opened: { batchState: string; firstRunTaken: boolean }) {
  const batch = { id: "b0000000-0000-4000-8000-000000000001", state: opened.batchState, reviewBy: null as number | null };
  if (input.action === "graph.read") return wikiGraphFixture("wiki", { types: types.map((t) => ({ ref: { installationId: "wiki", type: "graph-type", id: t.id }, attributes: t })) });
  if (input.action === "batch.seal-due") return { sealed: 0, expired: 0 };
  const firstRun = (input.input as { policy?: { kind: string } }).policy?.kind === "first-run";
  if (input.action === "batch.open" && firstRun && opened.firstRunTaken)
    throw new Response("This Wiki already has a discovery run; use the confidence policy", { status: 409 });
  if (input.action === "graph.mutate") {
    if ((input.input as { operationName: string }).operationName === "StageChanges") return { data: { stageChanges: { id: batch.id, state: "open", counts: {} } } };
    opened.batchState = "awaiting_review";
    return { data: { submitBatch: { id: batch.id, state: "awaiting_review", reviewBy: new Date(1_800_000_000_000).toISOString(), counts: { awaiting_review: 1 }, operations: [{ ref: "$change0", state: "awaiting_review" }] } } };
  }
  return { batch, counts: {} };
}
function fakeHost(confidence: number, opened: { batchState: string; firstRunTaken: boolean }) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const handlers: Record<string, Call> = {
    snapshot: () => { throw new Error("snapshot is not available in the schedule phase"); },
    schedules: () => [{ id: "50000000-0000-4000-8000-000000000001", workflowId: "forerunner-discovery", timezone: "Europe/London", inputs: {} }],
    "identity.current": () => ({ id: "alice", name: "Alice", email: "alice@example.test" }),
    "workflow.start": (input) => ({ id: input.id }),
    "workflow.collect": () => ({}),
    "session.append": () => ({}),
    "inference.generate": () => ({ output: semantic(confidence) }),
    "entities.types": () => ["graph-type", "graph-node", "graph-edge"].map((type) => ({ type, installationId: "wiki", writable: true })),
    "connector.execute": (input) => input.operation === "messages.list"
      ? { messages: [{ id: "m1" }] }
      : { id: "m1", subject: "Draft", snippet: "Bob: here is the draft.", from: "Bob <bob@example.test>", date: "2026-11-02" },
    "actions.call": (input) => wikiAction(input, opened),
  };
  const host = {
    call: async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      const handler = handlers[name];
      if (!handler) throw new Error(name);
      return handler(input);
    },
  } as unknown as WorkflowHost<"schedule">;
  return { host, calls };
}
async function database() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return { client, db };
}
const occurrence = (runId: string) => ({
  runId, scheduledFor: Date.now(),
  schedule: { id: "50000000-0000-4000-8000-000000000001", workflowId: "forerunner-discovery", inputs: { "analyze.inputs.provider": "gmail", "analyze.inputs.label": "Alice" }, connectionId: connection.id, resource: connection.resource },
});

test("the scheduled run reads only its connection and leaves an unsure finding for review until end of day", async (t) => {
  const { client, db } = await database();
  t.after(() => client.close());
  const { host, calls } = fakeHost(0.7, { batchState: "open", firstRunTaken: true });
  const result = await scheduledDiscovery(db, who, occurrence("90000000-0000-4000-8000-000000000001"), host);
  assert.deepEqual(result, { outcome: "started" });
  // The reserved run id starts the workflow run.
  assert.equal(calls.find((c) => c.name === "workflow.start")?.input.id, "90000000-0000-4000-8000-000000000001");
  const actions = calls.filter((c) => c.name === "actions.call").map((c) => c.input);
  assert.equal(actions[0].action, "batch.seal-due");
  const opens = actions.filter((a) => a.action === "batch.open").map((a) => (a.input as { policy: unknown }).policy);
  // The first-run policy is refused by the Wiki, so the run falls back to the daily policy.
  assert.deepEqual(opens, [
    { kind: "first-run", version: "forerunner-discovery-2026-11" },
    { kind: "confidence", threshold: 0.95, version: "forerunner-discovery-2026-11", reviewWindow: { until: "end-of-day", timezone: "Europe/London" } },
  ]);
  const staged = actions.find((a) => a.action === "graph.mutate" && (a.input as { operationName: string }).operationName === "StageChanges");
  assert.ok(staged);
  const added = (staged.input as { variables: { input: { proposals: { confidence: number; evidence: { provider: string; recordId: string }[] }[] } } }).variables.input;
  assert.equal(added.proposals[0].confidence, 0.7);
  assert.equal(added.proposals[0].evidence[0].provider, "gmail");
  const preview = await getPreview(db, who);
  assert.equal(preview?.batch?.policy, "confidence");
  assert.deepEqual(preview?.receipt, { batchId: "b0000000-0000-4000-8000-000000000001", state: "awaiting_review", reviewBy: 1_800_000_000_000, counts: { awaiting_review: 1 }, waiting: [String(preview?.operations[0].attributes.id)] });
});

test("a schedule for another workflow or without a connection is declined", async (t) => {
  const { client, db } = await database();
  t.after(() => client.close());
  const { host } = fakeHost(0.7, { batchState: "open", firstRunTaken: false });
  const other = occurrence("90000000-0000-4000-8000-000000000002");
  assert.equal((await scheduledDiscovery(db, who, { ...other, schedule: { ...other.schedule, workflowId: "elsewhere" } }, host)).outcome, "declined");
  assert.equal((await scheduledDiscovery(db, who, { ...other, schedule: { ...other.schedule, connectionId: null, resource: null } }, host)).outcome, "declined");
});

test("turning the daily run on saves a schedule for the chosen connection", async () => {
  const saved: Record<string, unknown>[] = [];
  const host = {
    call: async (name: string, input: Record<string, unknown>) => {
      if (name === "snapshot") return { connections: [connection] };
      if (name === "schedule.save") { saved.push(input); return {}; }
      if (name === "schedules") return [{ workflowId: "forerunner-discovery", enabled: true, connectionId: connection.id, timezone: "Europe/London", nextRunAt: 5, lastRunAt: null, lastOutcome: null }];
      throw new Error(name);
    },
  } as unknown as WorkflowHost<"interactive">;
  const status = await changeSchedule(host, who, { enabled: true, source: `connection:${connection.id}`, timezone: "Europe/London" });
  assert.equal(status.enabled, true);
  assert.deepEqual(saved[0], {
    workflow: "forerunner-discovery", timezone: "Europe/London", enabled: true,
    connectionId: connection.id, resource: connection.resource, inputs: { "analyze.inputs.provider": "gmail", "analyze.inputs.label": "Alice" },
  });
  await assert.rejects(changeSchedule(host, { ...who, canEdit: false }, { enabled: true, source: `connection:${connection.id}`, timezone: "UTC" }), (e: unknown) => e instanceof Response && e.status === 403);
  // The platform checks schedule inputs against the workflow definition, so they must be its run inputs.
  const definition = Workflow.parse(readWorkflowFile(fileURLToPath(new URL("../workflows/forerunner-discovery/workflow.yaml", import.meta.url))));
  const inputs = saved[0].inputs as Record<string, unknown>;
  for (const [path, value] of Object.entries(inputs)) {
    assert.equal(slotKind(definition, path), "inputs", path);
    assert.equal(slotIssue(definition, path, value), undefined, path);
  }
  assert.deepEqual(missingRunInputs(definition, inputs), []);
  assert.deepEqual(missingRunInputs(definition, {}), [], "a manual run needs no inputs");
});

/** A Settings host with these connections and saved schedules; `schedule.save` adds or replaces the one row. */
function settingsHost(connections: Record<string, unknown>[], schedules: Record<string, unknown>[] = []) {
  const saved: Record<string, unknown>[] = [];
  const host = {
    call: async (name: string, input: Record<string, unknown>) => {
      if (name === "snapshot") return { connections };
      if (name === "schedules") return schedules;
      if (name === "schedule.save") {
        saved.push(input);
        schedules.splice(0, schedules.length, { workflowId: input.workflow, enabled: input.enabled, connectionId: input.connectionId ?? null, timezone: input.timezone, nextRunAt: 7, lastRunAt: null, lastOutcome: null });
        return {};
      }
      throw new Error(name);
    },
  } as unknown as WorkflowHost<"interactive">;
  return { host, saved };
}
const calendar = { id: "c0000000-0000-4000-8000-000000000002", provider: "google-calendar", resource: "alice@example.test", label: "Alice", operations: ["events.list"] };

test("daily discovery turns itself on for a readable connection when no schedule was ever saved", async () => {
  const { host, saved } = settingsHost([calendar]);
  const status = await defaultSchedule(host, who, { timezone: "Europe/London" });
  assert.equal(status.enabled, true);
  assert.equal(status.connectionId, calendar.id);
  assert.deepEqual(saved, [{
    workflow: "forerunner-discovery", timezone: "Europe/London", enabled: true,
    connectionId: calendar.id, resource: calendar.resource, inputs: { "analyze.inputs.provider": "google-calendar", "analyze.inputs.label": "Alice" },
  }]);
  // Calling again on the next page load saves nothing more.
  await defaultSchedule(host, who, { timezone: "Europe/London" });
  assert.equal(saved.length, 1);
});

test("the default daily run prefers Gmail over Calendar", async () => {
  const { host, saved } = settingsHost([calendar, connection]);
  const status = await defaultSchedule(host, who, { timezone: "UTC" });
  assert.equal(status.connectionId, connection.id);
  assert.equal((saved[0].inputs as Record<string, unknown>)["analyze.inputs.provider"], "gmail");
});

test("the default daily run does nothing without a readable connection", async () => {
  // A Gmail connection that cannot list and get messages is not readable.
  const { host, saved } = settingsHost([{ ...connection, operations: ["drafts.create"] }]);
  const status = await defaultSchedule(host, who, { timezone: "UTC" });
  assert.equal(status.enabled, false);
  assert.deepEqual(saved, []);
});

test("the default daily run never re-enables a schedule the member turned off", async () => {
  const { host, saved } = settingsHost([connection], [{ workflowId: "forerunner-discovery", enabled: false, connectionId: connection.id, timezone: "UTC", nextRunAt: 9, lastRunAt: null, lastOutcome: null }]);
  const status = await defaultSchedule(host, who, { timezone: "UTC" });
  assert.equal(status.enabled, false);
  assert.equal(status.nextRunAt, null);
  assert.deepEqual(saved, []);
});

test("the default daily run is for personal editors only", async () => {
  const { host, saved } = settingsHost([connection]);
  await assert.rejects(defaultSchedule(host, { ...who, canEdit: false }, { timezone: "UTC" }), (e: unknown) => e instanceof Response && e.status === 403);
  // An organization's Forerunner does not start reading a member's mailbox on its own.
  const status = await defaultSchedule(host, { ...who, owner: { kind: "organization", id: "org" } }, { timezone: "UTC" });
  assert.equal(status.enabled, false);
  assert.deepEqual(saved, []);
});

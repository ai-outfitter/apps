import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { cancelRun, changeWorkflow, workflowsView } from "../src/server/workflows";

// The Workflows page over the platform documents: Schedules and WorkflowRuns list what
// runs for the member, ScheduleChanges and WorkflowRunChanges change it, each through
// the host's platform.document, as the member's MCP client would.
const who: AppIdentity = { installationId: "forerunner", userId: "alice", owner: { kind: "user", id: "alice" }, role: "owner", canEdit: true };
const [discoveryRun, routineRun] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const routineId = "33333333-3333-4333-8333-333333333333";
const personal = (app: string) => ({ scope: "personal", app });
const schedules = [
  { source: "workflow", target: personal("forerunner"), workflowId: "forerunner-discovery", cron: "0 7 * * *", timezone: "America/Chicago", createdBy: "alice",
    enabled: true, nextRunAt: 1_800_000_000_000, lastRunId: discoveryRun, lastRunStatus: "running", lastOutcome: "started" },
  { source: "routine", target: personal("platform"), routine: routineId, workflowId: "daily-brief", name: "Morning brief", cadence: "Weekdays at 13:00 UTC",
    cron: "0 13 * * 1-5", timezone: "UTC", enabled: true, nextRunAt: 1, lastRunId: routineRun, lastRunStatus: "running", lastOutcome: "started", canChange: true },
  { source: "routine", target: { scope: "acme", app: "platform" }, routine: "44444444-4444-4444-8444-444444444444", workflowId: "daily-brief", name: "Team brief",
    cron: "0 9 * * 1", timezone: "UTC", enabled: false, nextRunAt: null, lastRunId: null, lastOutcome: null, canChange: false },
  // Control calendars are not workflows.
  { source: "calendar", target: personal("planning"), workflowId: "x", cron: "", timezone: "UTC", enabled: true, nextRunAt: null, lastRunId: null, lastOutcome: null },
];
const runs = [
  { target: personal("forerunner"), run: discoveryRun, workflow: "forerunner-discovery", status: "running", steps: [{ id: "analyze", state: "running" }], createdAt: 20, updatedAt: 21 },
  { target: personal("platform"), run: routineRun, workflow: "daily-brief", status: "running", scheduleId: routineId, steps: [{ id: "brief", state: "running" }], createdAt: 10, updatedAt: 11 },
];

function fakeHost(receipt = "complete") {
  const calls: { document: string; kind: string; variables: Record<string, unknown> }[] = [];
  const host = {
    call: async (name: string, input: { document: string; kind: string; variables: Record<string, unknown> }) => {
      if (name !== "platform.document") throw new Error(`Unexpected host call ${name}`);
      calls.push(input);
      if (input.document === "Schedules") return { items: schedules };
      if (input.document === "WorkflowRuns") return { items: runs };
      const [item] = input.variables.items as { key: string }[];
      return { items: [{ key: item.key, status: receipt, ...(receipt === "failed" ? { error: { message: "Refused." } } : {}) }], instructions: [] };
    },
  } as unknown as WorkflowHost<"interactive">;
  return { host, calls };
}

async function database() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  const run = (id: string, data: Record<string, unknown>, createdAt: number) => client.execute({
    sql: "INSERT INTO forerunner_discovery_records (id, installationId, ownerId, kind, data, createdAt) VALUES (?, 'forerunner', 'alice', 'run', ?, ?)",
    args: [id, JSON.stringify(data), createdAt],
  });
  return { client, db: db as never, run };
}

test("every schedule and routine, across scopes, lists with the newest runs", async () => {
  const { client, db, run } = await database();
  try {
    await run("d1", { id: "d1", workflowRunId: discoveryRun, status: "analyzing", trigger: "schedule", startedAt: new Date(10).toISOString(), stages: [] }, 10);
    const { host, calls } = fakeHost();
    const view = await workflowsView(host, db, who);
    assert.deepEqual(calls.map((call) => [call.document, call.kind]), [["Schedules", "query"], ["WorkflowRuns", "query"]]);
    assert.deepEqual(view.workflows.map((w) => [w.name, w.kind, w.enabled, w.lastRun?.href ?? null, w.canChange, w.canDelete]), [
      ["Daily discovery", "app", true, "runs/d1", true, false],
      ["Morning brief", "routine", true, `/workflows/daily-brief/runs/${routineRun}`, true, true],
      ["Team brief · acme", "routine", false, null, false, false],
    ]);
    assert.equal(view.workflows[0].cadence, "Every day at 07:00 America/Chicago");
    assert.deepEqual(view.workflowRuns.map((r) => [r.name, r.stage, r.href]), [["Discovery", "analyzing", "runs/d1"], ["Morning brief", "brief", `/workflows/daily-brief/runs/${routineRun}`]]);
    // Members who cannot edit see nothing.
    await assert.rejects(workflowsView(host, db, { ...who, canEdit: false, role: "member" }));
  } finally { client.close(); }
});

test("run now, pause, resume and delete are ScheduleChanges items; a refusal keeps its message", async () => {
  const { host, calls } = fakeHost();
  await changeWorkflow(host, who, { change: "run", target: personal("forerunner"), workflow: "forerunner-discovery" });
  await changeWorkflow(host, who, { change: "delete", target: personal("platform"), routine: routineId });
  assert.deepEqual(calls.map((call) => [call.document, call.kind, (call.variables.items as Record<string, unknown>[]).map(({ key: _key, ...item }) => item)]), [
    ["ScheduleChanges", "mutation", [{ action: "run", target: personal("forerunner"), workflow: "forerunner-discovery" }]],
    ["ScheduleChanges", "mutation", [{ action: "delete", target: personal("platform"), routine: routineId }]],
  ]);
  const refused = fakeHost("failed");
  const error = await changeWorkflow(refused.host, who, { change: "pause", target: personal("platform"), routine: routineId }).then(() => null, (thrown: Response) => thrown);
  assert.ok(error instanceof Response);
  assert.deepEqual([error.status, await error.text()], [409, "Refused."]);
});

test("cancelling a run is a WorkflowRunChanges item, and a discovery run is marked failed at once", async () => {
  const { client, db, run } = await database();
  try {
    await run("d1", { id: "d1", workflowRunId: discoveryRun, status: "reading", startedAt: new Date(10).toISOString(), stages: [] }, 10);
    const { host, calls } = fakeHost();
    await cancelRun(host, db, who, { target: personal("forerunner"), run: discoveryRun });
    assert.deepEqual(calls.map((call) => [call.document, (call.variables.items as Record<string, unknown>[])[0].action]), [["WorkflowRunChanges", "cancel"]]);
    const [row] = (await client.execute("SELECT data FROM forerunner_discovery_records WHERE id = 'd1'")).rows;
    const stored = JSON.parse(String(row.data));
    assert.deepEqual([stored.status, stored.failedWhile, stored.error, Boolean(stored.canceledAt)], ["failed", "reading", "Canceled.", true]);
  } finally { client.close(); }
});

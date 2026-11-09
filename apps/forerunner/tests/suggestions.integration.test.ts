import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { ForerunnerContext } from "../src/server/context";
import { documents, runDocument } from "../src/server/documents";
import { generateSuggestions, listSuggestions, updateSuggestion } from "../src/server/suggestions";

// After a saved daily run, the `suggestions` step suggests new workflows, changes to the
// member's recurring tasks and apps; the member turns one on, applies a change or
// sets it aside, from the Workflows page or over MCP.
const who: AppIdentity = { installationId: "forerunner", userId: "alice", owner: { kind: "user", id: "alice" }, role: "owner", canEdit: true };
const task = (title: string) => ({ title, description: `${title}, each time.`, cadence: "Weekdays at 8am", steps: ["Read", "Write"] });
const routines = [
  { id: "r1", workflowId: "recurring-task", name: "Morning brief", cadence: "Weekdays at 13:00 UTC", enabled: true, task: task("Morning brief") },
  { id: "r2", workflowId: "daily-brief", name: "Markets", cadence: "Weekdays at 13:00 UTC", enabled: true, task: null },
];
const answer = { suggestions: [
  { kind: "change", title: "Cover the studio too", why: "Sign-up questions arrive most mornings.", routineId: "r1", task: task("Morning brief and studio"), app: null },
  { kind: "workflow", title: "Plan Thanksgiving guests", why: "Invitations went out this week.", routineId: null, task: task("Thanksgiving guests"), app: null },
  { kind: "app", title: "Class sign-ups", why: "Students ask by email.", routineId: null, task: null, app: { name: "Class sign-ups", goal: "Keep sign-ups in one place." } },
  // A daily-brief schedule is not a recurring task, so it cannot be rewritten.
  { kind: "change", title: "Rewrite markets", why: "x", routineId: "r2", task: task("Markets"), app: null },
] };

function fakeHost(output: unknown = answer) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const host = {
    call: async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      if (name === "routines.list") return { routines, runs: [] };
      if (name === "inference.generate") {
        if (output instanceof Error) throw output;
        return { output };
      }
      if (name === "workflow.collect") return { run: "complete", steps: {} };
      if (name === "routines.create") return { routine: routines[0], runId: "run-9" };
      if (name === "routines.update") return routines[0];
      throw new Error(`Unexpected host call ${name}`);
    },
  } as unknown as WorkflowHost<"interactive">;
  return { host, calls };
}

async function database() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return { client, db: db as never };
}

const read = { inputs: [{ subject: "Thanksgiving?", date: "2026-11-03", provider: "gmail", excerpt: "Can you come?" }], entries: [{ title: "Ada", kind: "Person", existing: false }] };

test("a saved daily run's suggestions are stored for the member, and only changes to their recurring tasks survive", async () => {
  const { client, db } = await database();
  try {
    const { host, calls } = fakeHost();
    const suggestions = await generateSuggestions(db, who, host, "run-1", read);
    assert.deepEqual(suggestions.map((suggestion) => [suggestion.kind, suggestion.title, suggestion.routineName]), [
      ["change", "Cover the studio too", "Morning brief"], ["workflow", "Plan Thanksgiving guests", null], ["app", "Class sign-ups", null],
    ]);
    const request = calls.find((call) => call.name === "inference.generate")?.input as { runId: string; step: string; data: { routines: { editable: boolean }[]; read: unknown[]; found: unknown[]; seen: unknown[] } };
    assert.deepEqual([request.runId, request.step], ["run-1", "suggestions"]);
    assert.deepEqual(request.data.routines.map((routine) => routine.editable), [true, false]);
    assert.equal(request.data.read.length, 1);
    assert.deepEqual(calls.at(-1), { name: "workflow.collect", input: { runId: "run-1", slot: "suggestions.outputs.result", value: { status: "ready", suggestions: 3 } } });

    // The next run sees what the member already has.
    const next = fakeHost({ suggestions: [] });
    await generateSuggestions(db, who, next.host, "run-2", read);
    const seen = (next.calls.find((call) => call.name === "inference.generate")!.input as { data: { seen: { title: string }[] } }).data.seen;
    assert.equal(seen.length, 3);
    assert.equal((await listSuggestions(db, who)).length, 3);
  } finally { client.close(); }
});

test("a workflow suggestion turns on a routine, a change rewrites its routine, and both leave the open list", async () => {
  const { client, db } = await database();
  try {
    const { host, calls } = fakeHost();
    const [change, workflow, app] = await generateSuggestions(db, who, host, "run-1", read);
    const context = { identity: who, db: () => db, host: () => host } as unknown as ForerunnerContext;
    const { updateSuggestion: turnedOn } = await runDocument(documents.UpdateSuggestion.document, { input: { id: workflow.id, status: "applied", timezone: "America/Chicago" } }, context);
    assert.equal(turnedOn.status, "applied");
    assert.deepEqual(calls.find((call) => call.name === "routines.create")?.input,
      { ...task("Thanksgiving guests"), evidence: "Invitations went out this week.", timezone: "America/Chicago" });
    await updateSuggestion(db, who, host, { id: change.id, status: "applied" });
    assert.deepEqual(calls.find((call) => call.name === "routines.update")?.input, { id: "r1", task: { ...task("Morning brief and studio"), evidence: "Sign-up questions arrive most mornings." } });
    await assert.rejects(updateSuggestion(db, who, host, { id: app.id, status: "applied" }), (error: Response) => error.status === 409);
    assert.equal((await updateSuggestion(db, who, host, { id: app.id, status: "dismissed" })).status, "dismissed");
    assert.deepEqual(await listSuggestions(db, who), []);
    assert.deepEqual((await listSuggestions(db, who, ["applied", "dismissed"])).map((suggestion) => [suggestion.title, suggestion.status]), [["Cover the studio too", "applied"], ["Plan Thanksgiving guests", "applied"], ["Class sign-ups", "dismissed"]]);
    await assert.rejects(updateSuggestion(db, who, host, { id: workflow.id, status: "dismissed" }), (error: Response) => error.status === 409);
  } finally { client.close(); }
});

test("a failed answer settles the step as failed and keeps the suggestions the member already has", async () => {
  const { client, db } = await database();
  try {
    const { host, calls } = fakeHost(new Error("model timed out"));
    assert.deepEqual(await generateSuggestions(db, who, host, "run-1", read), []);
    assert.deepEqual(calls.at(-1)?.input, { runId: "run-1", slot: "suggestions.outputs.result", value: { status: "failed", suggestions: 0 } });
  } finally { client.close(); }
});

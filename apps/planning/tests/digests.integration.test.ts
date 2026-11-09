import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { OrganizationIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import * as planning from "../src/server/planning";
import { changeDigestSchedule, listDigests, runDigestTask, scheduledDigests, startDigest } from "../src/server/digests";

const editor: OrganizationIdentity = {
  userId: "bob", organizationId: "org", owner: { kind: "organization", id: "org" },
  installationId: "planning-a", role: "owner", canEdit: true,
};
const member: OrganizationIdentity = { ...editor, userId: "alice", role: "member", canEdit: false };

async function setup() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return { client, db };
}

/** A workflow host double that records calls; inference answers or fails as told. */
function host(inference: "answer" | "fail" = "answer") {
  // biome-ignore lint/suspicious/noExplicitAny: a host double answers every operation's own input shape.
  type Input = Record<string, any>;
  const calls: { operation: string; input: Input }[] = [];
  const double = {
    async call(operation: string, input: Input) {
      calls.push({ operation, input });
      if (operation === "workflow.start") return { id: input.id, workflow: input.workflow, created: true };
      if (operation === "task.start") return { id: input.id, task: input.task, created: true };
      if (operation === "workflow.collect") return { run: {}, steps: [] };
      if (operation === "inference.generate") {
        if (inference === "fail") throw new Response("Inference unavailable", { status: 502 });
        return { output: { headline: "Launch plan shipped", summary: "The team shipped the launch plan." } };
      }
      if (operation === "schedule.save") return { ...input, id: "s1", nextRunAt: 1, lastRunAt: null, lastOutcome: null };
      throw new Error(`Unexpected ${operation}`);
    },
  };
  return { calls, host: double as unknown as WorkflowHost<"interactive"> & WorkflowHost<"schedule"> };
}
const issue = (projectId: string, title: string, status: "todo" | "in-progress" | "done" = "todo") =>
  ({ projectId, title, category: "stone" as const, status, description: "", assigneeId: null, dueDate: null, parentId: null });
const project = { name: "Launch", githubRepository: "", goals: "", userStories: "", pressRelease: "", demoInstructions: "", demoResults: "" };

test("the morning run writes a digest for each changed project and skips unchanged ones", async () => {
  const { client, db } = await setup();
  try {
    const launch = await planning.createProject(db, editor, project);
    const quiet = await planning.createProject(db, editor, { ...project, name: "Quiet" });
    const plan = await planning.createIssue(db, editor, issue(launch.id, "Write the launch plan"), []);
    await planning.createIssue(db, editor, issue(quiet.id, "Nothing happens here"), []);

    const first = host();
    assert.equal((await scheduledDigests(db, first.host, editor, "run-1")).written, 2);
    assert.deepEqual(first.calls[0], { operation: "workflow.start", input: { workflow: "project-digest", id: "run-1", inputs: {} } });
    assert.ok(first.calls.filter((call) => call.operation === "inference.generate").every((call) => call.input.step === "summarize" && call.input.runId === "run-1"));
    assert.deepEqual(first.calls.at(-1)?.input.value.written, 2);
    assert.equal(first.calls.at(-1)?.input.slot, "summarize.outputs.digests");

    // Only the launch project changes before the next morning.
    await planning.updateIssue(db, editor, plan.id, { ...issue(launch.id, "Write the launch plan", "done"), revision: plan.revision }, []);
    const second = host();
    const morning = await scheduledDigests(db, second.host, editor, "run-2");
    assert.deepEqual([morning.written, morning.unchanged], [1, 1]);
    const [latest] = await listDigests(db, editor, { projectId: launch.id });
    assert.equal(latest.trigger, "schedule");
    assert.deepEqual(latest.changes.shipped.map((item) => item.title), ["Write the launch plan"]);
    assert.equal(latest.summary, "Launch plan shipped\n\nThe team shipped the launch plan.");
    assert.equal((await listDigests(db, editor, { projectId: quiet.id })).length, 1, "an unchanged project gets no new digest");
    assert.deepEqual(await listDigests(db, { ...editor, installationId: "planning-b" }, { projectId: launch.id }), [], "digests stay in their installation");
  } finally {
    client.close();
  }
});

test("Generate digest now starts the registered task; the platform's dispatch saves the digest", async () => {
  const { client, db } = await setup();
  try {
    const launch = await planning.createProject(db, member, project);
    await planning.createIssue(db, member, issue(launch.id, "Write the launch plan", "in-progress"), []);
    const starting = host();
    await assert.rejects(startDigest(db, starting.host, member, { projectId: launch.id }), (error) => error instanceof Response && error.status === 403, "task starts need an editor");
    await startDigest(db, starting.host, editor, { projectId: launch.id });
    const start = starting.calls.find((call) => call.operation === "task.start");
    assert.equal(start?.input.task, "project-digest");
    assert.deepEqual(start?.input.inputs, { projectId: launch.id });
    assert.equal(starting.calls.filter((call) => call.operation === "workflow.start").length, 0, "the platform owns the run");

    // The platform dispatches the task as the editor; inference is unavailable, and the digest is still saved.
    const { calls, host: failing } = host("fail");
    const result = await runDigestTask(db, failing, editor, { runId: "99999999-9999-4999-8999-999999999999", task: "project-digest", inputs: { projectId: launch.id } }) as { digestIds: string[] };
    const [digest] = await listDigests(db, editor, { projectId: launch.id });
    assert.deepEqual(result.digestIds, [digest.id]);
    assert.equal(digest.summary, null);
    assert.equal(digest.summaryError, "Inference unavailable");
    assert.deepEqual(digest.changes.started.map((entry) => entry.title), ["Write the launch plan"]);
    assert.deepEqual(calls.at(-1), { operation: "workflow.collect", input: { runId: "99999999-9999-4999-8999-999999999999", slot: "summarize.outputs.digests", value: result } });
    await assert.rejects(startDigest(db, starting.host, editor, { projectId: crypto.randomUUID() }), (error) => error instanceof Response && error.status === 404);
  } finally {
    client.close();
  }
});

test("only editors turn the morning digest on", async () => {
  const { calls, host: double } = host();
  await assert.rejects(changeDigestSchedule(double, member, { enabled: true }), (error) => error instanceof Response && error.status === 403);
  assert.deepEqual(await changeDigestSchedule(double, editor, { enabled: true }), { enabled: true, nextRunAt: 1, lastRunAt: null, lastOutcome: null });
  assert.deepEqual(calls.at(-1)?.input, { workflow: "project-digest", timezone: "UTC", enabled: true, inputs: {} });
});

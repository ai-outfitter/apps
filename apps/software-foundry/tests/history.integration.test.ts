import assert from "node:assert/strict";
import test from "node:test";
import { threadTestHost } from "@ai-outfitter/app-test/threads";
import { threadArtifactPath, threadProvider, threadRefKey, type ThreadEntryPage, type Thread } from "@ai-outfitter/app-sdk/threads";
import { operations, type WorkflowHostStub, workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { MockLanguageModelV3 } from "ai/test";
import { historyTypes, runType, sessionType, workflowHistory } from "../src/server/history";

// Foundry's read-only history provider through the REAL platform thread service
// (@ai-outfitter/app-test/threads). The workflow host is a recording double that
// answers only the generic read operations with records shaped (and validated)
// exactly like the platform's `workflow.read`/`workflow.activity`/`artifacts.describe`.

const org = "org", foundry = "foundry-install", planning = "planning-install";
const now = Date.now();
const runId = "11111111-1111-4111-8111-111111111111";
const privateRun = "22222222-2222-4222-8222-222222222222";
const archives = {
  failed: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", // ready, unexpired
  expired: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  missing: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", // swept: host omits it
  pending: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};
function record(id: string, createdBy: string) {
  const parsed = operations["workflow.read"].output.parse({
    run: { id, workflowId: "issue-to-merge-workspace", status: "running", createdBy, createdAt: now - 60_000, updatedAt: now - 1_000 },
    inputs: { "triage.inputs.issue": { title: "Fix login", number: 7 } },
    outputs: {
      "triage.outputs.result": { value: { ready: true, sessionArtifact: { id: archives.expired, runId: id } }, complete: true },
      "implement.outputs.result": { value: { candidate: { number: 9 }, sessionArtifact: { id: archives.missing, runId: id } }, complete: true },
      "review.outputs.result": { value: { sessionArtifact: "not-a-reference" }, complete: true },
      "land.outputs.result": { value: { sessionArtifact: { id: archives.pending, runId: id } }, complete: false },
    },
    readiness: { run: "running", steps: { triage: "complete", implement: "complete", review: "complete", land: "running" } },
    attempts: [
      { id: "attempt-retry", nodeId: "implement", state: "complete", createdAt: now - 30_000, updatedAt: now - 20_000 },
      { id: "attempt-failed", nodeId: "implement", state: "failed", createdAt: now - 50_000, updatedAt: now - 40_000, failure: "Checks failed", sessionArtifact: { id: archives.failed, runId: id },
        ...(createdBy === "alice" ? { progress: { step: "tests", detail: "creator only" } } : {}) },
      { id: "attempt-land", nodeId: "land", state: "uncertain", createdAt: now - 10_000, updatedAt: now - 5_000 },
    ],
  });
  if (!parsed) throw new Error("fixture");
  return parsed;
}
/** The platform host for one member: owner-only runs stay with their creator; progress is creator-only. */
function workflowHostFor(userId: string, calls: string[]): WorkflowHostStub {
  const runs = [record(runId, "alice"), record(privateRun, "alice")];
  const ownerOnly = new Set([privateRun]);
  const visible = (run: ReturnType<typeof record>) => !ownerOnly.has(run.run.id) || run.run.createdBy === userId;
  const forCaller = (run: ReturnType<typeof record>) => ({
    ...run, attempts: run.attempts.map(({ progress, ...attempt }) => (run.run.createdBy === userId && progress ? { ...attempt, progress } : attempt)),
  });
  return {
    async call(operation, input) {
      calls.push(operation);
      const value = input as Record<string, unknown>;
      if (operation === "workflow.read") {
        const found = runs.find((run) => run.run.id === value.id && visible(run));
        return { ok: true, value: found ? forCaller(found) : null };
      }
      if (operation === "workflow.activity") {
        const items = runs.filter(visible).map((run) => ({ id: run.run.id, workflowId: run.run.workflowId, status: run.run.status, createdBy: run.run.createdBy,
          createdAt: run.run.createdAt, updatedAt: run.run.updatedAt, inputs: run.inputs }));
        return { ok: true, value: operations["workflow.activity"].output.parse({ total: items.length, items }) };
      }
      if (operation === "artifacts.describe") {
        const meta = {
          [archives.failed]: { state: "ready", expiresAt: now + 86_400_000 },
          [archives.expired]: { state: "ready", expiresAt: now - 1 },
          [archives.pending]: { state: "pending", expiresAt: now + 86_400_000 },
        } as Record<string, { state: string; expiresAt: number }>;
        return { ok: true, value: (value.ids as string[]).filter((id) => meta[id]).map((id) => ({ id, runId: value.runId, ...meta[id], contentType: "application/gzip", filename: "session.tar.gz" })) };
      }
      return { ok: false, status: 403, message: "Not a read operation" };
    },
  };
}

async function setup() {
  const hostCalls: string[] = [], providerCalls: string[] = [];
  const threads = await threadTestHost({
    model: () => new MockLanguageModelV3(),
    installations: [foundry],
    users: ["alice", "carol"],
    organizations: [org],
    provider: async ({ installationId, operation, input, principal }) => {
      providerCalls.push(operation);
      const identity = { installationId, owner: { kind: "organization" as const, id: org } };
      const history = () => workflowHistory(workflowHost<"interactive">({ props: { workflowHost: workflowHostFor(principal.userId, hostCalls) } }), identity);
      const response = await threadProvider({
        types: () => historyTypes,
        list: (value) => history().list(value),
        get: (value) => history().get(value),
        entries: (value) => history().entries(value),
      })(new Request(`https://foundry.test/api/internal/threads/v1/${operation}`, { method: "POST", body: JSON.stringify(input) }), operation);
      const text = await response.text();
      if (!response.ok) throw new Response(text, { status: response.status });
      return text ? JSON.parse(text) : null;
    },
  });
  // The caller is Planning, browsing Foundry's history with a member's identity.
  async function call<T>(userId: string, operation: string, input: unknown): Promise<T> {
    const result = await threads.stub({ userId, organizationId: org, installationId: planning }).call(operation, input);
    if (!result.ok) throw new Response(result.message, { status: result.status });
    return result.value as T;
  }
  return { threads, call, hostCalls, providerCalls };
}
const status = (n: number) => (e: unknown) => e instanceof Response && e.status === n;
const runRef = { installationId: foundry, type: runType, sourceId: runId };

test("Planning discovers Foundry's history provider and lists actual runs; owner-only runs stay with their creator", async () => {
  const t = await setup();
  const types = await t.call<{ type: string; kind: string; installationId: string; operations: string[] }[]>("alice", "threads.types", {});
  const run = types.find((type) => type.type === runType)!;
  assert.equal(run.kind, "history");
  assert.equal(run.installationId, foundry);
  assert.deepEqual(run.operations, ["list", "get", "entries"]);
  const mine = await t.call<{ threads: Thread[] }>("alice", "threads.list", { type: runType, installationId: foundry });
  assert.deepEqual(mine.threads.map((item) => item.ref), [runRef, { ...runRef, sourceId: privateRun }]);
  assert.ok(mine.threads.every((item) => item.readOnly));
  assert.match(mine.threads[0].title, /Fix login/);
  const carols = await t.call<{ threads: Thread[] }>("carol", "threads.list", { type: runType, installationId: foundry });
  assert.deepEqual(carols.threads.map((item) => ("sourceId" in item.ref ? item.ref.sourceId : item.ref.id)), [runId]);
  assert.equal(await t.call("carol", "threads.get", { ref: { ...runRef, sourceId: privateRun } }), null);
});

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one journey asserting every projected part of a run in order.
test("a run projects inputs, attempts (including failed retries), outputs, status and artifact evidence with stable ids and only recorded times", async () => {
  const t = await setup();
  const page = await t.call<ThreadEntryPage>("alice", "threads.entries", { ref: runRef, limit: 200 });
  const again = await t.call<ThreadEntryPage>("alice", "threads.entries", { ref: runRef, limit: 200 });
  assert.deepEqual(page.entries.map((e) => e.id), again.entries.map((e) => e.id), "stable source ids");
  const ids = page.entries.map((e) => e.id);
  assert.deepEqual(ids.slice(0, 4), [`${runId}:inputs`, `${runId}:attempt:attempt-failed`, `${runId}:attempt:attempt-retry`, `${runId}:attempt:attempt-land`]);
  assert.equal(ids.at(-1), `${runId}:status`);
  const byId = Object.fromEntries(page.entries.map((e) => [e.id, e]));
  assert.equal(byId[`${runId}:inputs`].recordedAt, now - 60_000);
  assert.equal(byId[`${runId}:attempt:attempt-failed`].recordedAt, now - 50_000);
  for (const entry of page.entries.filter((e) => e.id.includes(":output:") || e.id.endsWith(":status")))
    assert.equal(entry.recordedAt, null, "outputs and current status carry no invented time");
  const failed = byId[`${runId}:attempt:attempt-failed`].parts;
  assert.deepEqual(failed[0], { type: "attempt", attemptId: "attempt-failed", nodeId: "implement", state: "failed", failure: "Checks failed", createdAt: now - 50_000, updatedAt: now - 40_000 });
  const archive = failed.find((p) => p.type === "artifact")!;
  assert.equal(archive.type === "artifact" && archive.availability, "available");
  assert.equal(archive.type === "artifact" && archive.url, threadArtifactPath(runRef, archives.failed, true),
    "a source-scoped path, never the viewing app's own artifact route");
  assert.match(archive.type === "artifact" ? archive.name : "", /download only/);
  assert.ok(failed.some((p) => p.type === "thread-link" && p.relation === "session"));
  assert.ok(failed.some((p) => p.type === "data" && p.name === "software-foundry.progress"), "the creator sees their own progress");
  assert.ok(byId[`${runId}:attempt:attempt-land`].parts.some((p) => p.type === "text" && /not confirmed/.test(p.text)));
  const availability = (slot: string) => byId[`${runId}:output:${slot}`].parts.find((p) => p.type === "artifact");
  assert.equal(availability("triage.outputs.result")?.type === "artifact" && availability("triage.outputs.result")?.availability, "expired");
  assert.equal(availability("implement.outputs.result")?.type === "artifact" && availability("implement.outputs.result")?.availability, "missing");
  assert.equal(availability("review.outputs.result")?.type === "artifact" && availability("review.outputs.result")?.availability, "missing", "malformed references are shown as missing");
  assert.equal(availability("land.outputs.result")?.type === "artifact" && availability("land.outputs.result")?.availability, "incomplete");
  assert.ok(byId[`${runId}:output:land.outputs.result`].parts.some((p) => p.type === "text" && /incomplete/.test(p.text)));
  for (const entry of page.entries) for (const part of entry.parts) if (part.type === "artifact" && part.availability !== "available") assert.equal(part.url, undefined);
  const status = byId[`${runId}:status`].parts[0];
  assert.equal(status.type === "status" && status.status, "running", "never presented as complete");
  // Another member sees the run but not the creator's progress.
  const carol = await t.call<ThreadEntryPage>("carol", "threads.entries", { ref: runRef, limit: 200 });
  assert.ok(!carol.entries.flatMap((e) => e.parts).some((p) => p.type === "data" && p.name === "software-foundry.progress"));
  // Pages are bounded and continue with cursors.
  const first = await t.call<ThreadEntryPage>("alice", "threads.entries", { ref: runRef, limit: 3 });
  assert.equal(first.entries.length, 3);
  assert.ok(first.before);
  const earlier = await t.call<ThreadEntryPage>("alice", "threads.entries", { ref: runRef, limit: 3, before: first.before! });
  assert.ok(earlier.entries.every((e) => !first.entries.some((f) => f.id === e.id)));
});

test("retained sessions are linked child timelines that state their availability", async () => {
  const t = await setup();
  const ref = { installationId: foundry, type: sessionType, sourceId: `${runId}:attempt-failed` };
  const session = await t.call<Thread>("alice", "threads.get", { ref });
  assert.equal(session.parent?.id, threadRefKey(runRef));
  assert.equal(session.parent?.entryId, `${runId}:attempt:attempt-failed`);
  const page = await t.call<ThreadEntryPage>("alice", "threads.entries", { ref, limit: 10 });
  assert.ok(page.entries[0].parts.some((p) => p.type === "text" && /download-only evidence/.test(p.text)));
  const expired = await t.call<ThreadEntryPage>("alice", "threads.entries", { ref: { ...ref, sourceId: `${runId}:triage.outputs.result` }, limit: 10 });
  assert.ok(expired.entries[0].parts.some((p) => p.type === "text" && /expired/.test(p.text)));
  assert.equal(await t.call("alice", "threads.get", { ref: { ...ref, sourceId: `${runId}:no-such-attempt` } }), null);
});

test("inspecting history can never run, resume, cancel or modify a workflow", async () => {
  const t = await setup();
  const key = threadRefKey(runRef);
  for (const [operation, input] of [
    ["threads.send", { threadId: key, submissionId: crypto.randomUUID(), text: "retry it" }],
    ["threads.cancel", { threadId: key }],
    ["threads.delete", { threadId: key }],
    ["threads.append", { threadId: key, sourceKey: "x", role: "note", parts: [{ type: "text", text: "x" }] }],
    ["threads.update", { threadId: key, title: "Renamed" }],
    ["threads.create", { type: runType, title: "Fake run" }],
    ["threads.create", { type: "planning.conversation", title: "Child", parent: { id: key } }],
  ] as const)
    await assert.rejects(t.call("alice", operation, input), (e: unknown) => e instanceof Response && [400, 404, 405, 409].includes(e.status), operation);
  // The provider itself refuses conversation callbacks.
  for (const operation of ["prepare", "tool", "finish", "deleted"]) {
    const response = await threadProvider({ types: () => historyTypes })(new Request(`https://foundry.test/api/internal/threads/v1/${operation}`, { method: "POST", body: "{}" }), operation);
    assert.ok([400, 404].includes(response.status), operation);
  }
  assert.ok(t.providerCalls.every((op) => ["types", "list", "get", "entries"].includes(op)), t.providerCalls.join(","));
  assert.ok(t.hostCalls.every((op) => ["workflow.read", "workflow.activity", "artifacts.describe"].includes(op)), t.hostCalls.join(","));
  await assert.rejects(t.call("alice", "threads.send", { threadId: crypto.randomUUID(), submissionId: crypto.randomUUID(), text: "x" }), status(404));
});

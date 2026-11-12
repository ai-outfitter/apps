import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { threadTestHost } from "@ai-outfitter/app-test/threads";
import { threadProvider, type Thread } from "@ai-outfitter/app-sdk/threads";
import { type WorkflowHostStub, workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { createClient, type InValue } from "@libsql/client";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { claimKey, conversationType, intakeContext, planningConversations, planningThreadTypes, projectContext } from "../src/server/conversations";
import { createIssue, createProject, listPlanning, updateIssue, updateProject } from "../src/server/planning";
import type { BatchDatabase } from "../src/server/proposals";
import { actions } from "../src/server/agent";

// Planning's conversations run on the REAL platform thread service (in-memory
// libSQL via @ai-outfitter/app-test/threads) with Planning's provider callbacks
// dispatched through `threadProvider`. The model is a scripted fixture: passing
// tests prove no live inference provider.

const org = "org", installationId = "one";
const roles: Record<string, { role: string; canEdit: boolean; canAdminister: boolean }> = {
  alice: { role: "member", canEdit: false, canAdminister: false },
  bob: { role: "owner", canEdit: true, canAdminister: true },
  carol: { role: "member", canEdit: false, canAdminister: false },
};
const identity = (userId: string, installation = installationId) => ({
  userId, organizationId: org, owner: { kind: "organization" as const, id: org }, installationId: installation, ...roles[userId],
});
const status = (n: number) => (e: unknown) => e instanceof Response && e.status === n;
const finish = (reason: "stop" | "tool-calls" = "stop") => ({
  type: "finish" as const,
  finishReason: { unified: reason, raw: reason },
  usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
});
type Step = { text?: string; tools?: { name: string; input: unknown; id?: string }[] };

// A read-only workflow history provider: one organization run and one owner-only (private) run.
const historyRuns = [
  { sourceId: "run-shared", title: "SHARED-RUN", visibility: "organization" as const },
  { sourceId: "run-private", title: "PRIVATE-RUN", visibility: "private" as const },
];
function historyProvider(operation: string, input: unknown) {
  const item = (run: (typeof historyRuns)[number]) => ({ ...run, type: "fixture.run", typeVersion: 1, createdBy: "alice", status: "active", context: null, parent: null, createdAt: 1, updatedAt: 1 });
  if (operation === "types") return [{ type: "fixture.run", version: 1, label: "Runs", kind: "history", operations: ["list", "get", "entries"] }];
  if (operation === "list") return { threads: historyRuns.map(item), cursor: null };
  const run = historyRuns.find((candidate) => candidate.sourceId === (input as { sourceId: string }).sourceId);
  if (operation === "get") return run ? item(run) : null;
  return { entries: run ? [{ id: `${run.sourceId}:out`, role: "event", parts: [{ type: "text", text: `${run.title}-OUTPUT` }], status: "complete", submissionId: null, sourceKey: null,
    attribution: { actor: { kind: "app", id: "history" }, origin: { kind: "app", id: "history" }, userId: null, installationId: "history" }, metadata: null, createdAt: 1, recordedAt: null }] : [], before: null, after: null };
}

async function setup() {
  const client = createClient({ url: ":memory:" }), db = drizzle(client);
  await client.execute("PRAGMA foreign_keys=ON");
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  const raw: BatchDatabase = {
    query: async (s) => (await client.execute({ sql: s.sql, args: (s.params ?? []) as InValue[] })).rows as Record<string, unknown>[],
    batch: async (ss) => client.batch(ss.map((s) => ({ sql: s.sql, args: (s.params ?? []) as InValue[] })), "write"),
  };
  // A scripted model: each reply step takes the next scripted answer.
  let script: Step[] = [];
  const prompts: string[] = [];
  const model = () => new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const step = script.shift() ?? { text: "Done." };
      const chunks = [
        ...(step.text ? [{ type: "text-start" as const, id: "t" }, { type: "text-delta" as const, id: "t", delta: step.text }, { type: "text-end" as const, id: "t" }] : []),
        ...(step.tools ?? []).map((tool, i) => ({ type: "tool-call" as const, toolCallId: tool.id ?? `call-${prompts.length}-${i}`, toolName: tool.name, input: JSON.stringify(tool.input) })),
        finish(step.tools?.length ? "tool-calls" : "stop"),
      ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  let members: readonly string[] | undefined = ["alice", "bob", "carol"];
  const failures = new Set<string>();
  const appendFailures = { remaining: 0 };
  // eslint-disable-next-line prefer-const
  let threads: Awaited<ReturnType<typeof threadTestHost>>;
  /** The host a Planning request receives: the real thread service for that member. */
  const hostFor = (userId: string) => {
    const stub = threads.stub({ userId, organizationId: org, installationId, canAdminister: roles[userId].canAdminister });
    const flaky: WorkflowHostStub = {
      async call(operation, input) {
        if (operation === "threads.append" && appendFailures.remaining > 0) {
          appendFailures.remaining--;
          return { ok: false, status: 503, message: "Timeline temporarily unavailable" };
        }
        return stub.call(operation, input);
      },
    };
    return workflowHost<"interactive">({ props: { workflowHost: flaky } });
  };
  const planningFor = (userId: string) => planningConversations(raw, identity(userId), members, hostFor(userId));
  threads = await threadTestHost({
    model,
    installations: [installationId, "history"],
    users: Object.keys(roles),
    organizations: [org],
    provider: async ({ installationId: target, operation, input, principal }) => {
      if (failures.has(operation)) throw new Response("Provider unavailable", { status: 503 });
      if (target === "history") return historyProvider(operation, input);
      const planning = () => planningConversations(raw, identity(principal.userId, target), members, hostFor(principal.userId));
      const handler = threadProvider({
        types: () => planningThreadTypes,
        prepare: (value) => planning().prepare(value),
        tool: (value) => planning().tool(value),
        deleted: (value) => planning().deleting(value),
      });
      const response = await handler(new Request(`https://planning.test/api/internal/threads/v1/${operation}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }), operation);
      const text = await response.text();
      if (!response.ok) throw new Response(text, { status: response.status });
      return text ? JSON.parse(text) : null;
    },
  });
  const project = await createProject(db, identity("alice"), { name: "Launch", goals: "Saved goal", userStories: "Preserve existing stories" });
  const host = (userId: string) => threads.stub({ userId, organizationId: org, installationId, canAdminister: roles[userId].canAdminister });
  async function call<T>(userId: string, operation: string, input: unknown): Promise<T> {
    const result = await host(userId).call(operation, input);
    if (!result.ok) throw new Response(result.message, { status: result.status });
    return result.value as T;
  }
  const conversation = (userId: string, extra: Record<string, unknown> = {}) =>
    call<Thread>(userId, "threads.create", { type: conversationType, title: "Launch chat", context: { type: projectContext, id: project.id }, ...extra });
  async function send(userId: string, thread: Thread, text: string, steps: Step[], metadata?: unknown) {
    script = steps;
    const submissionId = crypto.randomUUID();
    await call(userId, "threads.send", { threadId: thread.id, submissionId, text, ...(metadata ? { metadata } : {}) });
    await threads.settle();
    return { submissionId, state: await call<{ state: string }>(userId, "threads.submission", { threadId: thread.id, submissionId }) };
  }
  const entries = async (userId: string, thread: Thread) =>
    (await call<{ entries: { id: string; role: string; parts: { type: string; [k: string]: unknown }[]; sourceKey: string | null }[] }>(userId, "threads.entries", { ref: { id: thread.id }, limit: 200 })).entries;
  const focus = { kind: "planning-project", id: project.id, label: "Browser cannot override this", revision: 1 };
  return {
    client, db, raw, project, threads, call, conversation, send, entries, planningFor, prompts, failures, appendFailures, focus,
    setMembers: (value: readonly string[] | undefined) => { members = value; },
  };
}

test("a contextual send prepares canonical bounded context, excludes drafts unless opted in and saves a private proposal", async () => {
  const t = await setup();
  try {
    const thread = await t.conversation("alice");
    const first = await t.send("alice", thread, "Prepare a goal change", [{ tools: [{ name: "amend_project", input: { goals: "Proposed goal" } }] }, { text: "Review the proposal." }],
      { [claimKey]: { focus: t.focus } });
    assert.equal(first.state.state, "completed");
    assert.match(t.prompts[0], /Saved goal/);
    assert.doesNotMatch(t.prompts[0], /unsavedDraft/);
    assert.doesNotMatch(t.prompts[0], /Browser cannot override this/, "canonical labels replace browser claims");
    const reply = (await t.entries("alice", thread)).find((e) => e.role === "assistant")!;
    const link = reply.parts.find((p) => p.type === "proposal")!;
    assert.equal(link.status, "pending");
    assert.equal((await listPlanning(t.db, identity("alice"))).projects[0].goals, "Saved goal", "nothing is written before approval");
    const [proposal] = await t.planningFor("alice").proposals.forThread(thread.id);
    assert.equal(proposal.id, link.proposalId);
    assert.deepEqual(proposal.changes, { goals: "Proposed goal" });
    // The proposal row has no conversation foreign key: it lives in Planning's own table.
    assert.equal((await t.client.execute("SELECT count(*) AS n FROM planning_proposals WHERE ownerId='alice'")).rows[0].n, 1);

    // A large opted-in draft is carried whole, never truncated.
    const big = "x".repeat(9000);
    t.prompts.length = 0;
    await t.send("alice", thread, "Discuss the draft", [{ text: "Noted." }], { [claimKey]: { focus: t.focus, draft: { goals: big } } });
    assert.ok(t.prompts[0].includes(big), "the whole >8 KiB draft reaches the model");

    // A stale page revision fails the reply before any tool runs.
    await updateProject(t.db, identity("alice"), t.project.id, { name: "Changed", revision: 1 });
    const stale = await t.send("alice", thread, "Help", [{ tools: [{ name: "amend_project", input: { goals: "Never" } }] }], { [claimKey]: { focus: t.focus } });
    assert.equal(stale.state.state, "failed");
    assert.equal((await t.planningFor("alice").proposals.forThread(thread.id)).length, 1);
  } finally { t.client.close(); }
});

test("the sidebar offers the five proposal tools with their schemas", async () => {
  const t = await setup();
  try {
    const thread = await t.conversation("alice");
    const entryId = crypto.randomUUID();
    const prepareInput = { thread, submissionId: crypto.randomUUID(), entry: { id: entryId } as never, retry: false };
    const prepared = await t.planningFor("alice").prepare(prepareInput);
    const replay = await t.planningFor("alice").prepare(prepareInput);
    const context = prepared.context as any;
    assert.equal(context.conversationSource.messageId, entryId);
    assert.equal(context.conversationSource.threadId, thread.id);
    assert.deepEqual(context.conversationSource, (replay.context as any).conversationSource);
    assert.ok(context.planningDocuments.write.includes("CreateIntake"));
    assert.ok(context.planningDocuments.write.includes("SetIntakeReleaseFit"));
    assert.match(prepared.instructions ?? "", /whose problem|whose|successCriteria/);
    for (const action of actions) assert.deepEqual(prepared.tools?.find(tool => tool.name === action.id)?.inputSchema, action.schema);
  } finally { t.client.close(); }
});

test("one project supports several conversations; private by default and explicitly shared ones are scoped per member", async () => {
  const t = await setup();
  try {
    const mine = await t.conversation("alice");
    const shared = await t.conversation("alice", { visibility: "organization", title: "Team" });
    assert.equal(mine.visibility, "private");
    const listed = await t.call<{ threads: Thread[] }>("alice", "threads.list", { type: conversationType, context: { type: projectContext, id: t.project.id } });
    assert.deepEqual(new Set(listed.threads.map((x) => x.id)), new Set([mine.id, shared.id]));
    const forCarol = await t.call<{ threads: Thread[] }>("carol", "threads.list", { type: conversationType, context: { type: projectContext, id: t.project.id } });
    assert.deepEqual(forCarol.threads.map((x) => x.id), [shared.id]);
    // Carol can use the shared conversation; her proposal is hers alone.
    await t.send("carol", shared, "Add an issue", [{ tools: [{ name: "create_issue", input: { title: "Carol's work", category: "stone" } }] }]);
    const [carols] = await t.planningFor("carol").proposals.forThread(shared.id);
    assert.ok(carols);
    assert.deepEqual(await t.planningFor("alice").proposals.forThread(shared.id), []);
    await assert.rejects(t.planningFor("alice").proposals.decide(carols.id, 1, "approve"), status(404), "reading a shared transcript grants no approval");
    await assert.rejects(t.planningFor("bob").proposals.decide(carols.id, 1, "approve"), status(404), "nor does administering the organization");
    await assert.rejects(planningConversations(t.raw, identity("carol", "two"), ["carol"], undefined).proposals.get(carols.id), status(404));
    assert.equal((await listPlanning(t.db, identity("alice"))).issues.length, 0);
  } finally { t.client.close(); }
});

test("the assistant opens and reads child conversations explicitly, two per originating entry, without sibling injection", async () => {
  const t = await setup();
  try {
    const parent = await t.conversation("alice");
    const outsider = await t.conversation("alice", { title: "Unrelated" });
    await t.send("alice", outsider, "Secret sibling notes", [{ text: "SIBLING-ONLY-REPLY" }]);
    const { submissionId } = await t.send("alice", parent, "Split this into two follow-ups", [
      { tools: [{ name: "start_child_conversation", input: { title: "Risks", brief: "RISK BRIEF" } }, { name: "start_child_conversation", input: { title: "Rollout" } }] },
      { text: "Opened two follow-ups." },
    ]);
    const children = (await t.call<{ threads: Thread[] }>("alice", "threads.list", { parentId: parent.id })).threads;
    assert.equal(children.length, 2);
    assert.ok(children.every((child) => child.parent?.id === parent.id && child.parent.entryId === submissionId), "both children share the originating entry");
    assert.ok(children.every((child) => child.visibility === parent.visibility));
    const risks = children.find((child) => child.title === "Risks")!;
    await t.send("alice", risks, "CHILD-ONLY-MESSAGE about risks", [{ text: "CHILD-ONLY-REPLY" }]);
    t.prompts.length = 0;
    await t.send("alice", parent, "What did the risks thread say?", [
      { tools: [{ name: "list_child_conversations", input: {} }, { name: "read_conversation", input: { threadId: risks.id, limit: 5 } }] },
      { text: "Summarized." },
    ]);
    assert.ok(!t.prompts[0].includes("CHILD-ONLY"), "children are not injected into the parent's context");
    assert.ok(!t.prompts.join("").includes("SIBLING-ONLY-REPLY"), "unrelated conversations are never read");
    assert.ok(t.prompts[1].includes("CHILD-ONLY-REPLY") && t.prompts[1].includes("RISK BRIEF"), "the explicitly read child page reaches the model");
    // A conversation that is neither child nor parent cannot be opened by the tool.
    const lateral = await t.send("alice", parent, "Read the other one", [{ tools: [{ name: "read_conversation", input: { threadId: outsider.id } }] }, { text: "ok" }]);
    const result = (await t.entries("alice", parent)).flatMap((e) => e.parts).filter((p) => p.type === "tool-result" && p.name === "read_conversation").at(-1)!;
    assert.ok(result.error, "lateral reads are refused");
    assert.notEqual(lateral.state.state, "running");
  } finally { t.client.close(); }
});

test("approval is atomic and replay-safe: stale revisions roll back, exact duplicates and lost responses never repeat a write", async () => {
  const t = await setup();
  try {
    const thread = await t.conversation("alice");
    await t.send("alice", thread, "Changes", [{ tools: [
      { name: "amend_project", input: { goals: "Reviewed goal" } },
      { name: "create_issue", input: { title: "Verify launch", category: "stone", assigneeId: "bob" } },
    ] }, { text: "Two proposals." }]);
    const planning = t.planningFor("alice").proposals;
    const all = await planning.forThread(thread.id);
    const doc = all.find((p) => p.action === "amend_project")!, issue = all.find((p) => p.action === "create_issue")!;
    const edited = await planning.revise(doc.id, 1, { goals: "Edited goal" });
    await assert.rejects(planning.decide(doc.id, 1, "approve"), status(409), "approving a superseded revision fails");
    const first = await planning.decide(edited.id, 2, "approve");
    // Lost response: the client retries the same decision.
    const again = await planning.decide(edited.id, 2, "approve");
    assert.deepEqual(again.receipt, first.receipt);
    const saved = (await listPlanning(t.db, identity("alice"))).projects[0];
    assert.equal(saved.revision, 2, "one domain write");
    assert.equal(saved.goals, "Edited goal");
    assert.equal(saved.userStories, "Preserve existing stories");
    const decisions = (await t.entries("alice", thread)).filter((e) => e.sourceKey === `planning.proposal:${doc.id}:decision`);
    assert.equal(decisions.length, 1, "one timeline record of the decision");
    assert.equal(decisions[0].parts[0].status, "applied");

    // Stale: a concurrent manual edit changes the target before approval.
    t.setMembers(["alice", "bob"]);
    await t.send("alice", thread, "Another", [{ tools: [{ name: "amend_project", input: { goals: "Stale change" } }] }, { text: "ok" }]);
    const stale = (await planning.forThread(thread.id)).at(-1)!;
    await updateProject(t.db, identity("alice"), t.project.id, { name: "Concurrent", revision: 2 });
    await assert.rejects(planning.decide(stale.id, 1, "approve"), status(409));
    assert.equal((await planning.get(stale.id)).status, "pending", "rolled back with the domain write");
    const concurrent = (await listPlanning(t.db, identity("alice"))).projects[0];
    assert.equal(concurrent.name, "Concurrent");
    assert.notEqual(concurrent.goals, "Stale change");
    assert.equal(concurrent.revision, 3);
    // Membership is revalidated at approval.
    t.setMembers(["alice"]);
    await assert.rejects(t.planningFor("alice").proposals.decide(issue.id, 1, "approve"), status(400));
    assert.equal((await planning.get(issue.id)).status, "pending");
    t.setMembers(["alice", "bob"]);
    await t.planningFor("alice").proposals.decide(issue.id, 1, "approve");
    assert.equal((await listPlanning(t.db, identity("alice"))).issues.length, 1);
  } finally { t.client.close(); }
});

test("a timeline sync failure after the domain commit is recovered later without repeating the write", async () => {
  const t = await setup();
  try {
    const thread = await t.conversation("alice");
    await t.send("alice", thread, "Change", [{ tools: [{ name: "amend_project", input: { goals: "Recovered goal" } }] }, { text: "ok" }]);
    const planning = t.planningFor("alice").proposals;
    const [proposal] = await planning.forThread(thread.id);
    t.appendFailures.remaining = 2;
    const decided = await planning.decide(proposal.id, 1, "approve");
    assert.equal(decided.proposal.status, "applied");
    assert.equal(decided.proposal.timelineSynced, false, "the receipt is committed even though the timeline write failed");
    // A retry after a lost response: same receipt, still no second domain write, sync retried (fails again).
    await planning.decide(proposal.id, 1, "approve");
    assert.equal((await listPlanning(t.db, identity("alice"))).projects[0].revision, 2);
    assert.equal((await t.entries("alice", thread)).filter((e) => e.sourceKey?.startsWith("planning.proposal:")).length, 0);
    // The next load records it exactly once.
    const [synced] = await planning.forThread(thread.id);
    assert.equal(synced.timelineSynced, true);
    await planning.decide(proposal.id, 1, "approve");
    await planning.forThread(thread.id);
    assert.equal((await t.entries("alice", thread)).filter((e) => e.sourceKey === `planning.proposal:${proposal.id}:decision`).length, 1);
    assert.equal((await listPlanning(t.db, identity("alice"))).projects[0].revision, 2);
  } finally { t.client.close(); }
});

test("exact tool replays return the same proposal; reused call ids with other input and expired submissions are refused", async () => {
  const t = await setup();
  try {
    const thread = await t.conversation("alice");
    const { submissionId } = await t.send("alice", thread, "One", [{ tools: [{ name: "create_issue", id: "fixed-call", input: { title: "Once", category: "sand" } }] }, { text: "ok" }]);
    const planning = t.planningFor("alice");
    const [proposal] = await planning.proposals.forThread(thread.id);
    // The submission is finished, so its worker cannot add proposals any more.
    const threadView = (await t.call<Thread>("alice", "threads.get", { ref: { id: thread.id } }));
    await assert.rejects(planning.tool({ thread: threadView, submissionId, call: { id: "fixed-call", name: "create_issue", input: { title: "Once", category: "sand" } }, calls: [] }), status(409));
    // Within the store, an exact replay of the same call returns the original proposal; other input conflicts.
    const replay = await planning.proposals.propose({ threadId: thread.id, submissionId, callId: "fixed-call", focusProjectId: t.project.id, action: "create_issue", value: { title: "Once", category: "sand" } });
    assert.equal(replay.id, proposal.id);
    assert.equal(replay.targetId, proposal.targetId, "a replay does not mint a new target id");
    await assert.rejects(planning.proposals.propose({ threadId: thread.id, submissionId, callId: "fixed-call", focusProjectId: t.project.id, action: "create_issue", value: { title: "Twice", category: "sand" } }), status(409));
    assert.equal((await planning.proposals.forThread(thread.id)).length, 1);
  } finally { t.client.close(); }
});

test("deleting a conversation cancels pending proposals first, keeps decided receipts and fails intact when Planning cannot acknowledge", async () => {
  const t = await setup();
  try {
    const shared = await t.conversation("alice", { visibility: "organization", title: "Team" });
    await t.send("alice", shared, "Two changes", [{ tools: [
      { name: "amend_project", input: { goals: "Applied goal" } },
      { name: "create_issue", input: { title: "Pending work", category: "pebble" } },
    ] }, { text: "ok" }]);
    const planning = t.planningFor("alice").proposals;
    const all = await planning.forThread(shared.id);
    const applied = all.find((p) => p.action === "amend_project")!, pending = all.find((p) => p.action === "create_issue")!;
    await planning.decide(applied.id, 1, "approve");
    // A failed acknowledgement leaves everything intact and retryable.
    t.failures.add("deleted");
    await assert.rejects(t.call("bob", "threads.delete", { threadId: shared.id }), status(503));
    assert.ok(await t.call("alice", "threads.get", { ref: { id: shared.id } }));
    assert.equal((await planning.get(pending.id)).status, "pending");
    t.failures.delete("deleted");
    // An administrator deletes the shared conversation holding Alice's pending proposal.
    const child = await t.call<Thread>("alice", "threads.create", { type: conversationType, title: "Child", context: { type: projectContext, id: t.project.id }, parent: { id: shared.id } });
    const removed = await t.call<{ detachedChildren: number }>("bob", "threads.delete", { threadId: shared.id });
    assert.equal(removed.detachedChildren, 1);
    assert.equal((await planning.get(pending.id)).status, "cancelled");
    assert.equal((await planning.get(applied.id)).status, "applied");
    assert.deepEqual((await planning.get(applied.id)).receipt, { id: t.project.id, revision: 2, action: "amend_project" });
    await assert.rejects(planning.decide(pending.id, 1, "approve"), status(409));
    assert.equal((await listPlanning(t.db, identity("alice"))).issues.length, 0, "a cancelled proposal never writes");
    assert.equal((await listPlanning(t.db, identity("alice"))).projects[0].goals, "Applied goal", "domain decisions survive deletion");
    assert.equal((await t.call<Thread>("alice", "threads.get", { ref: { id: child.id } })).parent, null, "children are detached, not deleted");
  } finally { t.client.close(); }
});

test("approval re-checks that the approver can still read the conversation", async () => {
  const t = await setup();
  try {
    const thread = await t.conversation("alice");
    await t.send("alice", thread, "Change", [{ tools: [{ name: "amend_project", input: { goals: "Gone" } }] }, { text: "ok" }]);
    const [proposal] = await t.planningFor("alice").proposals.forThread(thread.id);
    // Simulate a deletion that bypassed the acknowledgement (e.g. an operator reset).
    await t.threads.client.execute({ sql: "DELETE FROM messages WHERE chatId=?", args: [thread.id] });
    await t.threads.client.execute({ sql: "DELETE FROM chats WHERE id=?", args: [thread.id] });
    await assert.rejects(t.planningFor("alice").proposals.decide(proposal.id, 1, "approve"), status(409));
    assert.equal((await listPlanning(t.db, identity("alice"))).projects[0].goals, "Saved goal");
  } finally { t.client.close(); }
});

test("intake conversations offer only project actions; issue edits keep departed assignees and append category moves", async () => {
  const t = await setup();
  try {
    const intake = await t.call<Thread>("alice", "threads.create", { type: conversationType, title: "Intake", context: { type: intakeContext, id: "00000000-0000-4000-8000-000000000002" } });
    await t.send("alice", intake, 'Meeting: "Customer onboarding needs a better importer"', [
      { tools: [{ name: "create_issue", input: { title: "Nope", category: "sand" } }, { name: "create_project", input: { name: "Meeting planning", githubRepository: "https://github.com/ai-outfitter/webapp" } }] },
      { text: "ok" },
    ]);
    assert.match(t.prompts[0], /no selected project documents or issues/);
    const planning = t.planningFor("alice").proposals;
    const [created] = await planning.forThread(intake.id);
    assert.equal(created.action, "create_project");
    assert.equal((await planning.forThread(intake.id)).length, 1, "create_issue is not offered at intake");
    await planning.decide(created.id, created.revision, "approve");
    assert.equal((await listPlanning(t.db, identity("alice"))).projects.find((p) => p.id === created.targetId)?.githubRepository, "https://github.com/ai-outfitter/webapp");

    const issue = await createIssue(t.db, identity("alice"), { projectId: t.project.id, title: "Assigned", category: "stone", assigneeId: "bob" }, ["alice", "bob"]);
    await createIssue(t.db, identity("alice"), { projectId: t.project.id, title: "Existing sand", category: "sand" });
    t.setMembers(["alice"]);
    const thread = await t.conversation("alice");
    await t.send("alice", thread, "Move it", [{ tools: [{ name: "amend_issue", input: { targetId: issue.id, changes: { category: "sand", status: "done" } } }] }, { text: "ok" }],
      { [claimKey]: { focus: { kind: "planning-issue", id: issue.id, label: issue.title, revision: 1, project: { id: t.project.id, label: "Launch" } } } });
    const [move] = await t.planningFor("alice").proposals.forThread(thread.id);
    await t.planningFor("alice").proposals.decide(move.id, 1, "approve");
    const result = (await listPlanning(t.db, identity("alice"))).issues.find((i) => i.id === issue.id)!;
    assert.equal(result.assigneeId, "bob");
    assert.equal(result.position, 1);
    await updateIssue(t.db, identity("alice"), issue.id, { projectId: t.project.id, title: "Renamed", category: "sand", revision: 2 });
  } finally { t.client.close(); }
});

test("workflow histories keep their source privacy: a shared conversation never reads a private run", async () => {
  const t = await setup();
  try {
    const shared = await t.conversation("alice", { visibility: "organization" });
    t.prompts.length = 0;
    await t.send("alice", shared, "What ran?", [
      { tools: [{ name: "list_workflow_history", input: {} }, { name: "read_workflow_history", input: { installationId: "history", type: "fixture.run", sourceId: "run-private" } }] },
      { text: "Listed." },
    ]);
    const seen = t.prompts.join("");
    assert.ok(seen.includes("SHARED-RUN"), "organization runs are listed");
    assert.ok(!seen.includes("PRIVATE-RUN"), "a private run never reaches a reply stored in a shared conversation");
    const stored = JSON.stringify(await t.entries("alice", shared));
    assert.ok(!stored.includes("PRIVATE-RUN") && !stored.includes("SHARED-RUN-OUTPUT"), "history read results are not stored");

    const mine = await t.conversation("alice");
    t.prompts.length = 0;
    await t.send("alice", mine, "Read my run", [
      { tools: [{ name: "read_workflow_history", input: { installationId: "history", type: "fixture.run", sourceId: "run-private" } }] },
      { text: "Read." },
    ]);
    assert.ok(t.prompts.join("").includes("PRIVATE-RUN-OUTPUT"), "the creator's private conversation may read it");
  } finally { t.client.close(); }
});

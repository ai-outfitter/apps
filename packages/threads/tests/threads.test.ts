import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { eq } from "drizzle-orm";
import { attachments, chats, messages } from "../src/schema";
import { conversationTypes, member, memoryObjects, service, threadDatabase } from "./helpers/fixture";

const finish = {
  type: "finish" as const,
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
};
const textModel = (text: string, prompts: unknown[] = []) => () => ({
  effort: false,
  model: new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(options.prompt);
      return { stream: simulateReadableStream({ chunks: [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, finish] }) };
    },
  }),
});
const status = (code: number) => (error: unknown) => error instanceof Response && error.status === code;
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const settle = (retained: Promise<unknown>[]) => Promise.all(retained.splice(0));

test("organization threads are private by default; shared ones reach every member; personal threads stay the user's", async () => {
  const { db } = await threadDatabase();
  const { threads } = service(db, { model: textModel("hi") });
  const alice = member("alice", "acme"), bob = member("bob", "acme");
  const privateThread = await threads.create(alice, { type: "chat.conversation", title: "Mine" });
  const shared = await threads.create(alice, { type: "chat.conversation", title: "Team", visibility: "organization" });
  const personal = await threads.create(member("alice", null), { type: "chat.conversation", title: "Home", visibility: "organization" });
  assert.equal(privateThread.visibility, "private");
  assert.equal(personal.visibility, "private", "personal threads are always private");
  assert.deepEqual(personal.owner, { kind: "user", id: "alice" });
  assert.deepEqual(shared.owner, { kind: "organization", id: "acme" });
  assert.equal(await threads.get(bob, { id: privateThread.id }), null);
  assert.equal((await threads.get(bob, { id: shared.id }))?.title, "Team");
  assert.equal(await threads.get(bob, { id: personal.id }), null);
  assert.equal(await threads.get(member("alice", "other"), { id: shared.id }), null, "another organization sees nothing");
  assert.equal(await threads.get(member("alice", "acme"), { id: personal.id }), null, "an organization scope does not read personal threads");
  // A resident or platform scope (no member context) sees only shared threads, even with the creator's id.
  const resident = member("alice", "acme", { memberContext: false, actor: { kind: "resident", id: "r" } });
  assert.equal(await threads.get(resident, { id: privateThread.id }), null);
  assert.ok(await threads.get(resident, { id: shared.id }));
  assert.deepEqual((await threads.list(bob, {})).threads.map((t) => t.id), [shared.id]);
  assert.deepEqual(new Set((await threads.list(alice, {})).threads.map((t) => t.id)), new Set([privateThread.id, shared.id]));
  await assert.rejects(threads.entries(bob, { ref: { id: privateThread.id } }), status(404));
});

test("children inherit their parent's owner and visibility; the relation never grants access", async () => {
  const { db } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  const { threads } = service(db, { model: textModel("reply"), retained });
  const alice = member("alice", "acme"), bob = member("bob", "acme");
  const parent = await threads.create(alice, { type: "chat.conversation", title: "Root" });
  await threads.send(alice, { threadId: parent.id, submissionId: crypto.randomUUID(), text: "start" });
  await settle(retained);
  const [root] = (await threads.entries(alice, { ref: { id: parent.id } })).entries;
  const first = await threads.create(alice, { type: "chat.conversation", title: "A", visibility: "organization", parent: { id: parent.id, entryId: root.id } });
  const second = await threads.create(alice, { type: "chat.conversation", title: "B", parent: { id: parent.id, entryId: root.id } });
  assert.equal(first.visibility, "private", "a child of a private thread is private whatever it asks");
  assert.deepEqual(first.parent, { id: parent.id, entryId: root.id });
  assert.equal(second.parent?.entryId, root.id, "several children may start from one entry");
  assert.equal((await threads.list(alice, { parentId: parent.id })).threads.length, 2);
  await assert.rejects(threads.create(bob, { type: "chat.conversation", title: "X", parent: { id: parent.id } }), status(404));
  assert.equal((await threads.list(bob, { parentId: parent.id })).threads.length, 0);
});

test("exact duplicate submissions return the existing result; conflicting reuse is refused", async () => {
  const { db } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  const settled: string[] = [];
  const { threads, calls } = service(db, { model: textModel("Answer"), retained, settled });
  const alice = member("alice", "acme");
  const thread = await threads.create(alice, { type: "chat.conversation", title: "T" });
  const submissionId = crypto.randomUUID();
  const sent = await threads.send(alice, { threadId: thread.id, submissionId, text: "Question", metadata: { focus: "x" } });
  assert.equal(sent.state.state, "running");
  await settle(retained);
  const replay = await threads.send(alice, { threadId: thread.id, submissionId, text: "Question", metadata: { focus: "x" } });
  assert.equal(replay.state.state, "completed");
  assert.equal(replay.state.replyEntryIds.length, 1);
  assert.equal(calls.filter((call) => call.operation === "prepare").length, 1, "no second reply");
  await assert.rejects(threads.send(alice, { threadId: thread.id, submissionId, text: "Changed" }), status(409));
  await assert.rejects(threads.send(alice, { threadId: thread.id, submissionId, text: "Question", metadata: { focus: "y" } }), status(409), "metadata is part of the payload");
  const elsewhere = await threads.create(alice, { type: "chat.conversation", title: "U" });
  await assert.rejects(threads.send(alice, { threadId: elsewhere.id, submissionId, text: "Question", metadata: { focus: "x" } }), status(409));
  const page = await threads.entries(alice, { ref: { id: thread.id } });
  assert.deepEqual(page.entries.map((e) => [e.role, e.status, e.parts.find((p) => p.type === "text")]), [
    ["user", "complete", { type: "text", text: "Question" }], ["assistant", "complete", { type: "text", text: "Answer" }]]);
  assert.deepEqual(page.entries[0].metadata, { focus: "x" });
  assert.deepEqual(page.entries[0].attribution.actor, { kind: "member", id: "alice" });
  const prepare = calls.find((call) => call.operation === "prepare")?.input as { entry: { metadata: unknown }; submissionId: string };
  assert.deepEqual(prepare.entry.metadata, { focus: "x" }, "prepare receives the user entry's metadata");
  assert.equal(prepare.submissionId, submissionId);
  assert.deepEqual(settled, ["completed"]);
});

test("one reply per thread; independent threads run together; an expired worker is fenced", async () => {
  const { db } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const model = () => ({ effort: false, model: new MockLanguageModelV3({ doStream: async () => {
    await gate;
    return { stream: simulateReadableStream({ chunks: [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "late" }, { type: "text-end", id: "t" }, finish] }) };
  } }) });
  const { threads } = service(db, { model, retained });
  const alice = member("alice", "acme");
  const one = await threads.create(alice, { type: "chat.conversation", title: "1" });
  const two = await threads.create(alice, { type: "chat.conversation", title: "2" });
  const first = crypto.randomUUID();
  await threads.send(alice, { threadId: one.id, submissionId: first, text: "a" });
  await threads.send(alice, { threadId: two.id, submissionId: crypto.randomUUID(), text: "b" });
  await assert.rejects(threads.send(alice, { threadId: one.id, submissionId: crypto.randomUUID(), text: "c" }), status(409));
  // The first worker's lease lapses and a newer reply takes the thread over.
  await db.update(chats).set({ leaseUntil: 1 }).where(eq(chats.id, one.id));
  const newer = crypto.randomUUID();
  await threads.send(alice, { threadId: one.id, submissionId: newer, text: "d" });
  release();
  await settle(retained);
  const [row] = await db.select().from(chats).where(eq(chats.id, one.id));
  assert.equal(row.leaseToken, null, "the newer worker released its own lease");
  const replies = await db.select().from(messages).where(eq(messages.chatId, one.id));
  assert.equal(replies.filter((m) => m.role === "assistant" && m.submissionId === first).length, 0, "the fenced worker wrote nothing");
  assert.equal(replies.filter((m) => m.role === "assistant" && m.submissionId === newer).length, 1);
  assert.equal((await threads.submission(alice, one.id, first))?.state, "interrupted");
  assert.equal((await db.select().from(messages).where(eq(messages.chatId, two.id))).filter((m) => m.role === "assistant").length, 1);
});

test("a model failure keeps the partial reply, and retry runs again only when asked", async () => {
  const { db } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  let fail = true;
  const model = () => ({ effort: false, model: new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream<never>({ chunks: (fail
    ? [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Half an ans" }, { type: "error", error: new Error("provider down") }]
    : [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Whole answer" }, { type: "text-end", id: "t" }, finish]) as never[] }) }) }) });
  const { threads } = service(db, { model, retained });
  const alice = member("alice", "acme");
  const thread = await threads.create(alice, { type: "chat.conversation", title: "T" });
  const submissionId = crypto.randomUUID();
  await threads.send(alice, { threadId: thread.id, submissionId, text: "Go" });
  await settle(retained);
  const failed = await threads.submission(alice, thread.id, submissionId);
  assert.equal(failed?.state, "partial");
  const [partial] = (await threads.entries(alice, { ref: { id: thread.id } })).entries.filter((e) => e.role === "assistant");
  assert.equal(partial.status, "error");
  assert.deepEqual(partial.parts, [{ type: "text", text: "Half an ans" }]);
  assert.equal((await threads.send(alice, { threadId: thread.id, submissionId, text: "Go" })).state.state, "partial", "a plain replay does not rerun");
  fail = false;
  await threads.send(alice, { threadId: thread.id, submissionId, text: "Go", retry: true });
  await settle(retained);
  const retried = await threads.submission(alice, thread.id, submissionId);
  assert.equal(retried?.state, "completed");
  assert.equal(retried?.replyEntryIds.length, 2, "the partial reply is preserved beside the retry");
  const users = (await db.select().from(messages).where(eq(messages.chatId, thread.id))).filter((m) => m.role === "user");
  assert.equal(users.length, 1, "a retry never duplicates the user entry");
});

test("tools run through the provider, their parts are stored, and a stop tool ends the reply", async () => {
  const { db } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  let step = 0;
  const model = () => ({ effort: false, model: new MockLanguageModelV3({ doStream: async () => {
    step++;
    return { stream: simulateReadableStream({ chunks: [
      { type: "tool-call", toolCallId: "call-1", toolName: "propose", input: JSON.stringify({ title: "Ship" }) },
      { ...finish, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" } },
    ] }) };
  } }) });
  const { threads, calls } = service(db, { model, retained, provider: ({ operation }) => {
    if (operation === "prepare") return { instructions: "Use tools", tools: [{ name: "propose", description: "Propose", inputSchema: { type: "object", properties: { title: { type: "string" } } }, stop: true }] };
    if (operation === "tool") return { output: { proposalId: "p1" }, parts: [{ type: "proposal", installationId: "chat-app", proposalId: "p1", status: "pending" }] };
  } });
  const alice = member("alice", "acme");
  const thread = await threads.create(alice, { type: "chat.conversation", title: "T" });
  await threads.send(alice, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "Plan it" });
  await settle(retained);
  assert.equal(step, 1, "the stop tool ended the reply");
  const tool = calls.find((call) => call.operation === "tool")?.input as { call: { name: string; input: unknown } };
  assert.deepEqual(tool.call, { id: "call-1", name: "propose", input: { title: "Ship" } });
  const [reply] = (await threads.entries(alice, { ref: { id: thread.id } })).entries.filter((e) => e.role === "assistant");
  assert.deepEqual(reply.parts.map((part) => part.type), ["tool-call", "tool-result", "proposal"]);
  assert.ok(calls.some((call) => call.operation === "finish"));
});

test("a provider that asks for platform tools gets the platform's tools and instructions in private threads only", async () => {
  const { db } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  const systems: string[] = [];
  const offered: string[][] = [];
  let step = 0;
  const model = () => ({ effort: false, model: new MockLanguageModelV3({ doStream: async ({ prompt, tools }) => {
    if (step === 0) { systems.push(String(prompt.find((m) => m.role === "system")?.content ?? "")); offered.push((tools ?? []).map((t) => t.name).sort()); }
    step++;
    const chunks: LanguageModelV3StreamPart[] = step === 1 && systems.at(-1)?.startsWith("Platform")
      ? [{ type: "tool-call", toolCallId: "q-1", toolName: "graph_query", input: JSON.stringify({ document: "WorkflowRuns" }) }, { ...finish, finishReason: { unified: "tool-calls", raw: "tool_calls" } }]
      : [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Done" }, { type: "text-end", id: "t" }, finish];
    return { stream: simulateReadableStream({ chunks }) };
  } }) });
  const ran: unknown[] = [];
  const { threads, calls } = service(db, { model, retained,
    provider: ({ operation }) => operation === "prepare" ? { instructions: "Sidebar", platformTools: true, tools: [
      { name: "graph_query", description: "The app's own", inputSchema: { type: "object" } },
      { name: "board_read", description: "Read the board", inputSchema: { type: "object" } },
    ] } : undefined,
    platformTools: async (principal) => ({ instructions: `Platform docs for ${principal.userId}`, minSteps: 6, tools: [
      { name: "graph_query", description: "Platform query", inputSchema: { type: "object", properties: { document: { type: "string" } } }, run: async (input) => { ran.push(input); return { items: [{ run: "r1" }] }; } },
    ] }) });
  const alice = member("alice", "acme");
  const mine = await threads.create(alice, { type: "chat.conversation", title: "Mine" });
  await threads.send(alice, { threadId: mine.id, submissionId: crypto.randomUUID(), text: "What did my last run read?" });
  await settle(retained);
  assert.match(systems[0], /^Platform docs for alice\n\nSidebar/, "platform instructions come before the provider's");
  assert.deepEqual(offered[0], ["board_read", "graph_query"], "the platform's tool replaces a provider tool of the same name");
  assert.deepEqual(ran, [{ document: "WorkflowRuns" }], "the platform runs its own tool");
  assert.ok(!calls.some((call) => call.operation === "tool"), "the provider never runs a platform tool");
  const [reply] = (await threads.entries(alice, { ref: { id: mine.id } })).entries.filter((e) => e.role === "assistant");
  assert.deepEqual(reply.parts.find((part) => part.type === "tool-result"), { type: "tool-result", callId: "q-1", name: "graph_query", output: { omitted: true } }, "platform results are not stored");

  step = 0;
  const shared = await threads.create(alice, { type: "chat.conversation", title: "Shared", visibility: "organization" });
  await threads.send(alice, { threadId: shared.id, submissionId: crypto.randomUUID(), text: "Hi" });
  await settle(retained);
  assert.equal(systems[1], "Sidebar", "an organization-shared thread gets no platform tools");
  assert.deepEqual(offered[1], ["board_read", "graph_query"]);
});

test("cancel stops a running reply and keeps what arrived", async () => {
  const { db } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  const model = () => ({ effort: false, model: new MockLanguageModelV3({ doStream: async ({ abortSignal }) => ({ stream: new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "t" });
      controller.enqueue({ type: "text-delta", id: "t", delta: "Partial" });
      abortSignal?.addEventListener("abort", () => controller.error(abortSignal.reason));
    },
  }) }) }) });
  const { threads } = service(db, { model, retained });
  const alice = member("alice", "acme"), bob = member("bob", "acme");
  const thread = await threads.create(alice, { type: "chat.conversation", title: "T", visibility: "organization" });
  const submissionId = crypto.randomUUID();
  await threads.send(alice, { threadId: thread.id, submissionId, text: "Go" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(threads.cancel(bob, thread.id, submissionId), status(403), "another member cannot stop it");
  assert.deepEqual(await threads.cancel(alice, thread.id, submissionId), { canceled: true });
  await settle(retained);
  const state = await threads.submission(alice, thread.id, submissionId);
  assert.equal(state?.state, "aborted");
  const [reply] = (await threads.entries(alice, { ref: { id: thread.id } })).entries.filter((e) => e.role === "assistant");
  assert.deepEqual(reply.parts, [{ type: "text", text: "Partial" }]);
});

test("app-appended entries are idempotent by source key", async () => {
  const { db } = await threadDatabase();
  const { threads } = service(db, { model: textModel("x") });
  const alice = member("alice", "acme");
  const thread = await threads.create(alice, { type: "chat.conversation", title: "T" });
  const entry = { threadId: thread.id, sourceKey: "receipt:p1", role: "event" as const, parts: [{ type: "proposal" as const, installationId: "chat-app", proposalId: "p1", status: "applied" }] };
  const first = await threads.append(alice, entry);
  const again = await threads.append(alice, entry);
  assert.equal(again.id, first.id);
  await assert.rejects(threads.append(alice, { ...entry, parts: [{ type: "status", status: "other" }] }), status(409));
  await assert.rejects(threads.append(member("alice", "acme", { installationId: "another-app" }), entry), status(403));
  assert.equal((await threads.entries(alice, { ref: { id: thread.id } })).entries.length, 1);
});

test("deleting a thread removes its entries and images, detaches children and needs the provider's acknowledgement", async () => {
  const { db } = await threadDatabase();
  const objects = memoryObjects();
  const retained: Promise<unknown>[] = [];
  let acknowledge = false;
  const notified: unknown[] = [];
  const { threads } = service(db, {
    model: textModel("ok"), objects, retained,
    types: [{ ...conversationTypes[0], notify: ["deleted"] }],
    provider: ({ operation, input }) => {
      if (operation !== "deleted") return undefined;
      notified.push(input);
      if (!acknowledge) throw new Response("busy", { status: 500 });
      return { ok: true };
    },
  });
  const alice = member("alice", "acme"), admin = member("bob", "acme", { canAdminister: true });
  const thread = await threads.create(alice, { type: "chat.conversation", title: "T", visibility: "organization" });
  const image = await threads.upload(alice, thread.id, new Request("https://x.test", { method: "POST", headers: { "Content-Type": "image/png", "X-Filename": "a.png" }, body: PNG.slice() }));
  await threads.send(alice, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "with image", attachments: [image.id] });
  await settle(retained);
  const [entry] = (await threads.entries(alice, { ref: { id: thread.id } })).entries;
  assert.equal(entry.parts[0].type, "file");
  const child = await threads.create(alice, { type: "chat.conversation", title: "Child", parent: { id: thread.id, entryId: entry.id } });
  await assert.rejects(threads.remove(member("carol", "acme"), thread.id), status(403), "an ordinary member cannot delete another's shared thread");
  await assert.rejects(threads.remove(admin, thread.id), status(503), "an unacknowledged deletion changes nothing");
  assert.equal((await threads.entries(alice, { ref: { id: thread.id } })).entries.length, 2);
  assert.equal(objects.store.size, 1);
  acknowledge = true;
  assert.deepEqual(await threads.remove(admin, thread.id), { deleted: true, detachedChildren: 1 });
  await settle(retained);
  assert.deepEqual(notified.at(-1), { threadId: thread.id, type: "chat.conversation", context: null });
  assert.equal(await threads.get(alice, { id: thread.id }), null);
  assert.equal(objects.store.size, 0, "its images are removed");
  assert.equal((await db.select().from(attachments)).length, 0);
  const survived = await threads.get(alice, { id: child.id });
  assert.equal(survived?.parent, null, "the child survives, detached");
});

test("provider-owned history is read through the provider and refuses every mutation", async () => {
  const { db } = await threadDatabase();
  const history = { type: "flow.workflow-run", version: 1, label: "Runs", kind: "history", operations: ["list", "get", "entries"] };
  const item = { sourceId: "run-1", type: "flow.workflow-run", title: "Run 1", createdAt: 0, updatedAt: 0 };
  const { threads } = service(db, {
    model: textModel("x"), installations: ["chat-app", "flow-app"],
    types: [...conversationTypes, history],
    provider: ({ installationId, operation, input }) => {
      if (installationId !== "flow-app") return undefined;
      if (operation === "list") return { threads: [item] };
      if (operation === "get") return (input as { sourceId: string }).sourceId === "run-1" ? item : null;
      if (operation === "entries") return { entries: [{ id: "e0", role: "event", createdAt: 0, recordedAt: null,
        attribution: { actor: { kind: "app", id: "flow-app" }, origin: { kind: "member", id: "alice" }, userId: null, installationId: "flow-app" },
        parts: [{ type: "attempt", attemptId: "a1", nodeId: "build", state: "failed", failure: "boom" }, { type: "flow.custom", anything: 1 }] }] };
    },
  });
  const alice = member("alice", "acme", { installationId: "planning" });
  const listed = await threads.list(alice, { type: "flow.workflow-run", installationId: "flow-app" });
  assert.equal(listed.threads[0].readOnly, true);
  assert.deepEqual(listed.threads[0].ref, { installationId: "flow-app", type: "flow.workflow-run", sourceId: "run-1" });
  const page = await threads.entries(alice, { ref: listed.threads[0].ref });
  assert.equal(page.entries[0].parts[0].type, "attempt");
  assert.deepEqual(page.entries[0].parts[1], { type: "data", name: "unknown", data: { type: "flow.custom", anything: 1 } }, "unknown parts fall back to structured data");
  assert.equal(page.entries[0].recordedAt, null, "no fabricated time");
  assert.equal(await threads.get(alice, { installationId: "flow-app", type: "flow.workflow-run", sourceId: "nope" }), null);
  await assert.rejects(threads.create(member("alice", "acme", { installationId: "flow-app" }), { type: "flow.workflow-run", title: "x" }), status(405));
});

test("uploads are validated and private until sent; history types are read-only", async () => {
  const { db } = await threadDatabase();
  const { threads } = service(db, { model: textModel("x") });
  const alice = member("alice", "acme"), bob = member("bob", "acme");
  const thread = await threads.create(alice, { type: "chat.conversation", title: "T", visibility: "organization" });
  const upload = (bytes: Uint8Array, type = "image/png") => new Request("https://x.test", { method: "POST", headers: { "Content-Type": type, "X-Filename": "a.png" }, body: bytes.slice() });
  await assert.rejects(threads.upload(alice, thread.id, upload(new Uint8Array([1, 2, 3]))), status(422));
  await assert.rejects(threads.upload(alice, thread.id, upload(PNG, "application/pdf")), status(415));
  const file = await threads.upload(alice, thread.id, upload(PNG));
  assert.equal((await threads.readAttachment(alice, thread.id, file.id)).status, 200);
  await assert.rejects(threads.readAttachment(bob, thread.id, file.id), status(404), "a pending upload is its uploader's alone");
  await assert.rejects(threads.send(bob, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "x", attachments: [file.id] }), status(404));
  await assert.rejects(threads.create(alice, { type: "chat.unknown", title: "?" }), status(409), "only a declared type can be created");
});

test("account deletion removes personal and private threads; organization-shared history survives its creator", async () => {
  const { db, client } = await threadDatabase();
  const { threads } = service(db, { model: textModel("x") });
  const alice = member("alice", "acme");
  const personal = await threads.create(member("alice", null), { type: "chat.conversation", title: "Home" });
  const privateThread = await threads.create(alice, { type: "chat.conversation", title: "Private" });
  const shared = await threads.create(alice, { type: "chat.conversation", title: "Team", visibility: "organization" });
  await assert.rejects(client.execute({ sql: "DELETE FROM user WHERE id=?", args: ["alice"] }), /CHECK|constraint/i,
    "a personal thread blocks deleting its owner until it is purged");
  assert.equal(await threads.purgeUser("alice"), 2);
  await client.execute({ sql: "DELETE FROM user WHERE id=?", args: ["alice"] });
  const rows = await db.select().from(chats);
  assert.deepEqual(rows.map((row) => [row.id, row.userId]), [[shared.id, null]]);
  assert.ok(await threads.get(member("bob", "acme"), { id: shared.id }));
  void personal; void privateThread;
});

test("a thread records the version its provider declares, and keeps it on replay", async () => {
  const { db } = await threadDatabase();
  const { threads } = service(db, { model: textModel("x"), types: [{ ...conversationTypes[0], version: 2 }] });
  const alice = member("alice", "acme");
  const input = { id: crypto.randomUUID(), type: "chat.conversation", title: "v2" };
  assert.equal((await threads.create(alice, input)).typeVersion, 2);
  assert.equal((await threads.create(alice, input)).typeVersion, 2);
});

test("store:false tool results serve this reply only: never persisted, never replayed; notes never reach the model", async () => {
  const { db } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  const prompts: string[] = [];
  let turn = 0;
  const model = () => ({ effort: false, model: new MockLanguageModelV3({ doStream: async (options) => {
    prompts.push(JSON.stringify(options.prompt));
    turn++;
    const chunks = turn === 1
      ? [{ type: "tool-call", toolCallId: "mail-1", toolName: "read_mail", input: JSON.stringify({ query: "invoice" }) },
         { type: "tool-call", toolCallId: "profile-1", toolName: "edit_profile", input: JSON.stringify({ goal: "x" }) },
         { ...finish, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" } }]
      : [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: `Answer ${turn}` }, { type: "text-end", id: "t" }, finish];
    return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
  } }) });
  const toolInputs: { call: { name: string }; calls: { name: string; callId: string }[] }[] = [];
  const { threads } = service(db, { model, retained, provider: ({ operation, input }) => {
    if (operation === "prepare") return { instructions: "Mail assistant", tools: [
      { name: "read_mail", description: "Read mail", inputSchema: { type: "object" }, store: false },
      { name: "edit_profile", description: "Edit profile", inputSchema: { type: "object" } },
    ] };
    if (operation === "tool") {
      toolInputs.push(input as never);
      return (input as { call: { name: string } }).call.name === "read_mail"
        ? { output: { messages: [{ from: "colleague@example.test", body: "SECRET MAIL BODY" }] } }
        : { output: { refused: "edits after a mail read" } };
    }
  } });
  const alice = member("alice", "acme");
  const thread = await threads.create(alice, { type: "chat.conversation", title: "Mail", visibility: "organization",
    entries: [{ id: crypto.randomUUID(), role: "note", text: "SEED PROMPT NOTE", metadata: { "chat.prompt": true } }] });
  await threads.send(alice, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "Find my invoice" });
  await settle(retained);
  assert.ok(prompts[1].includes("SECRET MAIL BODY"), "the model uses the result within the reply");
  assert.deepEqual(toolInputs.map((input) => [input.call.name, input.calls.map((call) => call.name)]),
    [["read_mail", []], ["edit_profile", ["read_mail"]]], "each tool call sees the calls made before it in this submission");
  const stored = JSON.stringify(await db.select().from(messages).where(eq(messages.chatId, thread.id)));
  assert.equal(stored.includes("SECRET MAIL BODY"), false, "the raw result is never persisted");
  const [reply] = (await threads.entries(alice, { ref: { id: thread.id } })).entries.filter((entry) => entry.role === "assistant");
  assert.deepEqual(reply.parts.find((part) => part.type === "tool-result" && part.name === "read_mail"), { type: "tool-result", callId: "mail-1", name: "read_mail", output: { omitted: true } });
  await threads.send(alice, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "And again" });
  await settle(retained);
  const later = prompts.at(-1) ?? "";
  assert.equal(later.includes("SECRET MAIL BODY"), false);
  assert.equal(later.includes("mail-1"), false, "the transient call is not replayed");
  assert.ok(later.includes("profile-1"), "stored tool results are replayed");
  assert.equal(prompts.some((prompt) => prompt.includes("SEED PROMPT NOTE")), false, "notes are not model messages");
});

test("only the member who sent a submission may retry it", async () => {
  const { db } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  let fail = true;
  const { threads } = service(db, {
    retained,
    model: () => fail ? { effort: false, model: new MockLanguageModelV3({ doStream: async () => { throw new Error("provider down"); } }) } : textModel("ok")(),
  });
  const alice = member("alice", "acme"), bob = member("bob", "acme");
  const shared = await threads.create(alice, { type: "chat.conversation", title: "Team", visibility: "organization" });
  const submissionId = crypto.randomUUID();
  await threads.send(alice, { threadId: shared.id, submissionId, text: "hi" });
  await settle(retained);
  fail = false;
  await assert.rejects(threads.send(bob, { threadId: shared.id, submissionId, text: "hi", retry: true }), status(403));
  const state = await threads.send(alice, { threadId: shared.id, submissionId, text: "hi", retry: true });
  assert.ok(state);
  await settle(retained);
});

test("an app listing its own type sees only its threads, not another app declaring the same name", async () => {
  const { db } = await threadDatabase();
  const { threads } = service(db, { model: textModel("hi"), installations: ["chat-app", "another-app"] });
  const alice = member("alice", "acme");
  const mine = await threads.create(alice, { type: "chat.conversation", title: "Real", visibility: "organization" });
  const squat = await threads.create(member("bob", "acme", { installationId: "another-app" }), { type: "chat.conversation", title: "Squat", visibility: "organization" });
  assert.deepEqual((await threads.list(alice, { type: "chat.conversation" })).threads.map((t) => t.id), [mine.id]);
  assert.deepEqual((await threads.list(alice, { type: "chat.conversation", installationId: "another-app" })).threads.map((t) => t.id), [squat.id], "an explicit installation still lists its threads");
  assert.equal((await threads.get(alice, { id: squat.id }))?.title, "Squat", "shared threads stay readable by reference");
});

test("deleting a thread with a running reply stops the reply and refuses until it ends", async () => {
  const { db } = await threadDatabase();
  const { threads } = service(db, { model: textModel("hi") });
  const alice = member("alice", "acme");
  const thread = await threads.create(alice, { type: "chat.conversation", title: "Busy" });
  const token = crypto.randomUUID();
  await db.update(chats).set({ leaseToken: token, leaseUntil: Date.now() + 60_000 }).where(eq(chats.id, thread.id));
  await assert.rejects(threads.remove(alice, thread.id), status(409));
  const [row] = await db.select().from(chats).where(eq(chats.id, thread.id));
  assert.equal(row?.cancelToken, token, "the running reply was asked to stop");
  await db.update(chats).set({ leaseUntil: 0 }).where(eq(chats.id, thread.id));
  await threads.remove(alice, thread.id);
  assert.equal(await threads.get(alice, { id: thread.id }), null);
});

test("app-owned schema descriptors reach threads.types callers unchanged; unknown parts keep the structured fallback", async () => {
  const { db } = await threadDatabase();
  const schemas = [
    { name: "acme.project", version: 1, kind: "context", title: "Acme project", schema: { type: "object", properties: { id: { type: "string" } } } },
    { name: "acme.progress", version: 2, kind: "part", title: "Progress", schema: { type: "object", required: ["done"], properties: { done: { type: "number" } } } },
  ];
  const published = [{ ...conversationTypes[0], contexts: ["acme.project"], parts: ["acme.progress"], schemas }];
  const { threads } = service(db, { model: textModel("x"), types: published });
  const alice = member("alice", "acme");
  const [type] = await threads.types(alice);
  assert.deepEqual(type.schemas, schemas);
  assert.equal(type.installationId, "chat-app");
  // Schemas describe; the platform does not reject a part that does not match one.
  const thread = await threads.create(alice, { type: "chat.conversation", title: "T" });
  const appended = await threads.append(alice, { threadId: thread.id, sourceKey: "p1", role: "event", parts: [{ type: "data", name: "acme.progress", version: 2, data: { done: "not a number" } }] });
  assert.equal(appended.parts[0].type, "data");
  // An oversized schema makes the provider's metadata invalid: it publishes nothing, as any invalid descriptor.
  const { threads: invalid } = service(db, { model: textModel("x"), types: [{ ...published[0], schemas: [{ ...schemas[0], schema: { blob: "x".repeat(20 * 1024) } }] }] });
  assert.deepEqual(await invalid.types(alice), []);
});

test("thinking effort reaches the provider only when the resolved model supports it", async () => {
  const seen: unknown[] = [];
  const effortModel = (supported: boolean) => () => ({
    effort: supported,
    model: new MockLanguageModelV3({
      doStream: async (options) => {
        seen.push(options.providerOptions);
        return { stream: simulateReadableStream({ chunks: [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "ok" }, { type: "text-end", id: "t" }, finish] }) };
      },
    }),
  });
  for (const supported of [true, false]) {
    const { db } = await threadDatabase();
    const retained: Promise<unknown>[] = [];
    const { threads, calls } = service(db, { model: effortModel(supported), retained });
    const alice = member("alice", "acme");
    const thread = await threads.create(alice, { type: "chat.conversation", title: "Think" });
    await threads.send(alice, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "hard question", effort: "high" });
    await settle(retained);
    const prepare = calls.find((call) => call.operation === "prepare");
    assert.ok(prepare, "the provider was prepared");
    assert.equal((prepare.input as { effort?: string }).effort, "high", "the provider sees the member's choice");
  }
  assert.deepEqual((seen[0] as { openai?: unknown }).openai, { reasoningEffort: "high" });
  assert.equal(seen[1], undefined, "an unsupported model gets no reasoning option");
});


test("a snapshot restores only readable same-installation and same-context conversations", async () => {
  const { db, client } = await threadDatabase();
  try {
    const { threads } = service(db, { model: textModel("hi") });
    const alice = member("alice", "acme"), bob = member("bob", "acme");
    const context = { type: "chat.project", id: "project" };
    const own = await threads.create(alice, { type: "chat.conversation", context, title: "Mine" });
    const foreign = await threads.create(bob, { type: "chat.conversation", context, title: "Private Bob" });
    const shared = await threads.create(bob, { type: "chat.conversation", context, title: "Shared Bob", visibility: "organization" });
    await client.execute({ sql: "UPDATE chats SET updatedAt=? WHERE id=?", args: [Date.now() + 1000, shared.id] });
    assert.equal((await threads.snapshot(alice, { type: "chat.conversation", context })).thread?.id, own.id, "opening a simple sidebar never silently selects a shared conversation");
    assert.equal((await threads.snapshot(alice, { type: "chat.conversation", context, preferred: shared.id })).thread?.id, shared.id, "an explicit readable shared preference remains usable");
    const other = await threads.create(alice, { type: "chat.conversation", context: { ...context, id: "elsewhere" }, title: "Other context" });
    const restored = await threads.snapshot(alice, { type: "chat.conversation", context, preferred: foreign.id });
    assert.equal(restored.thread?.id, own.id, "a private foreign preference never selects or discloses it");
    assert.equal((await threads.snapshot(alice, { type: "chat.conversation", context, preferred: other.id })).thread?.id, own.id);
    assert.equal((await threads.snapshot(member("alice", "other"), { type: "chat.conversation", context, preferred: own.id })).thread, null);
    assert.equal((await threads.snapshot(member("alice", "acme", { installationId: "another-app" }), { type: "chat.conversation", context, preferred: own.id })).thread, null);
    await assert.rejects(threads.snapshot(alice, { type: "chat.conversation", context, limit: 1000 }));
  } finally { client.close(); }
});

test("a current provider that does not answer discovery is an outage; an undeclared type is a conflict", async () => {
  const { db } = await threadDatabase();
  const alice = member("alice", "acme");
  const thread = await service(db, { model: textModel("hi") }).threads.create(alice, { type: "chat.conversation", title: "T" });
  const down = service(db, { model: textModel("hi"), types: () => { throw new Response("Unavailable", { status: 502 }); } }).threads;
  await assert.rejects(down.send(alice, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "Hello" }), status(503));
  await assert.rejects(service(db, { model: textModel("hi") }).threads.create(alice, { type: "chat.unknown", title: "?" }), status(409));
});

test("inspect prepares the latest member turn again for administrators only, and calls no model", async () => {
  const { db } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  const prompts: unknown[] = [];
  const page = { location: "/person/p1", title: "Ada" };
  const { threads, calls } = service(db, {
    model: () => ({ ...textModel("Hi", prompts)(), describe: { provider: "Outfitter", model: "luna" } }),
    retained,
    inspector: async (principal) => principal.userId === "alice",
    provider: ({ operation, input }) => {
      if (operation !== "prepare") return;
      const { entry } = input as { entry: { metadata?: Record<string, unknown> } };
      return { instructions: "Wiki helper", context: { currentPage: entry.metadata?.["app.page"] ?? null, records: [1] },
        tools: [{ name: "read_record", description: "Read one record", inputSchema: { type: "object" } }], maxSteps: 3 };
    },
  });
  const alice = member("alice", "acme");
  const thread = await threads.create(alice, { type: "chat.conversation", title: "T", visibility: "organization" });
  assert.deepEqual(await threads.inspect(alice, thread.id), { model: { provider: "Outfitter", model: "luna" }, turn: null });
  await threads.send(alice, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "Who is this?", metadata: { "app.page": page } });
  await settle(retained);
  const before = prompts.length;
  const inspected = await threads.inspect(alice, thread.id);
  assert.equal(prompts.length, before, "no model call");
  assert.equal(inspected.turn?.system, "Wiki helper");
  assert.deepEqual(inspected.turn?.context, { currentPage: page, records: [1] });
  assert.deepEqual(inspected.turn?.tools.map((tool) => tool.name), ["read_record"]);
  assert.equal(inspected.turn?.maxSteps, 3);
  assert.equal(calls.filter((call) => call.operation === "prepare").length, 2);
  const here = { location: "/person/p2", title: "Grace" };
  assert.deepEqual((await threads.inspect(alice, thread.id, { metadata: { "app.page": here } })).turn?.context, { currentPage: here, records: [1] }, "the current page stands in for the stored one");
  await assert.rejects(threads.inspect(member("bob", "acme"), thread.id), status(404));
  assert.equal(await threads.inspector(member("bob", "acme")), false);
});

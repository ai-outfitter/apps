import assert from "node:assert/strict";
import test from "node:test";
import { createThreadService } from "../src/service";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { conversationTypes, member, memoryObjects, service, threadDatabase } from "./helpers/fixture";

const model = () => ({
  effort: false,
  model: new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: [
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: "Saved answer" },
        { type: "text-end" as const, id: "answer" },
        {
          type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ] }),
    }),
  }),
});

const responseStatus = (status: number) => (error: unknown) =>
  error instanceof Response && error.status === status;

test("a seeded thread creation id cannot be reused for different source content", async () => {
  const { db, client } = await threadDatabase();
  try {
    const { threads } = service(db, { model });
    const principal = member("alice", "acme");
    const input = {
      id: crypto.randomUUID(), type: "chat.conversation", title: "Claimed conversation",
      context: { type: "planning.project", id: "project", label: "Original label" },
      entries: [{ id: crypto.randomUUID(), role: "user" as const, text: "Original guest message" }],
    };
    await threads.create(principal, input);
    await assert.rejects(threads.create(principal, {
      ...input, entries: [{ ...input.entries[0], text: "Different guest message" }],
    }), responseStatus(409));
    await assert.rejects(threads.create(principal, {
      ...input, context: { ...input.context, label: "Different source label" },
    }), responseStatus(409));
    const entries = await threads.entries(principal, { ref: { id: input.id } });
    assert.deepEqual(entries.entries[0].parts, [{ type: "text", text: "Original guest message" }]);
  } finally { client.close(); }
});

test("an exact creation replay still succeeds after the thread title is edited", async () => {
  const { db, client } = await threadDatabase();
  try {
    const { threads } = service(db, { model });
    const principal = member("alice", "acme");
    const input = { id: crypto.randomUUID(), type: "chat.conversation", title: "Original title" };
    await threads.create(principal, input);
    await threads.update(principal, { threadId: input.id, title: "Edited title" });
    const replay = await threads.create(principal, input);
    assert.equal(replay.id, input.id);
    assert.equal(replay.title, "Edited title", "replay must preserve later user edits");
  } finally { client.close(); }
});

/** Hold both initial message reads before either request can acquire a lease.
 * This reproduces separate Workers' interleaving on a single SQLite connection. */
function simultaneousPreflight<T extends object>(database: T, submissionId: string, table = "messages") {
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const isPreflight = (sql: { sql: string; params: unknown[] }) =>
    sql.sql.includes(`from "${table}"`) && sql.sql.includes(`"${table}"."id" = ?`) && sql.params.includes(submissionId);
  async function execute(target: object) {
    const sql = Reflect.get(target, "toSQL").call(target) as { sql: string; params: unknown[] };
    const result = await (target as PromiseLike<unknown>);
    if (reads >= 2 || !isPreflight(sql)) return result;
    reads++;
    if (reads === 2) release();
    await gate;
    return result;
  }
  function query(original: object): object {
    return new Proxy(original, {
      get(target, property) {
        if (property === "then") return (
          fulfilled: (value: unknown) => unknown,
          rejected: (error: unknown) => unknown,
        ) => execute(target).then(fulfilled, rejected);
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          return result && typeof result === "object" && typeof Reflect.get(result, "then") === "function"
            ? query(result) : result;
        };
      },
    });
  }
  const db = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "select" && typeof value === "function") return (...args: unknown[]) => query(Reflect.apply(value, target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, release, count: () => reads };
}

test("simultaneous identical submissions converge after both observe an empty preflight", async () => {
  const { db, client } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  const submissionId = crypto.randomUUID();
  const barrier = simultaneousPreflight(db, submissionId);
  const timeout = setTimeout(barrier.release, 4000);
  try {
    const { threads, calls } = service(barrier.db, { model, retained });
    const principal = member("alice", "acme");
    const thread = await threads.create(principal, { type: "chat.conversation", title: "Concurrent replay" });
    const input = { threadId: thread.id, submissionId, text: "One submission" };
    const outcomes = await Promise.allSettled([threads.send(principal, input), threads.send(principal, input)]);
    assert.equal(barrier.count(), 2, "the test must exercise the cross-request interleaving");
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled"]);
    await Promise.all(retained.splice(0));
    assert.equal(calls.filter((call) => call.operation === "prepare").length, 1);
    const entries = await threads.entries(principal, { ref: { id: thread.id } });
    assert.equal(entries.entries.filter((entry) => entry.role === "user").length, 1);
    assert.equal(entries.entries.filter((entry) => entry.role === "assistant").length, 1);
  } finally {
    clearTimeout(timeout);
    barrier.release();
    await Promise.allSettled(retained);
    client.close();
  }
});

test("discovery failure cannot bypass an unavailable deletion acknowledgement on a fresh request", async () => {
  const { db, client } = await threadDatabase();
  let unavailable = false;
  const options = {
    model,
    provider: ({ operation }: { operation: string }) => {
      if (operation === "deleted") throw new Response("Deletion callback unavailable", { status: 500 });
      return undefined;
    },
    get types() {
      if (unavailable) throw new Response("Provider unavailable", { status: 500 });
      return conversationTypes.map((type) => ({ ...type, notify: ["deleted"] }));
    },
  };
  try {
    const principal = member("alice", "acme");
    const original = service(db, options).threads;
    const thread = await original.create(principal, { type: "chat.conversation", title: "Pending proposals" });
    unavailable = true;
    const freshRequest = service(db, options).threads;
    await assert.rejects(freshRequest.remove(principal, thread.id), responseStatus(503));
    assert.ok(await original.get(principal, { id: thread.id }), "history must survive unavailable lifecycle metadata");
  } finally { client.close(); }
});

test("a concurrent submission identity cannot execute in two different threads", async () => {
  const { db, client } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  const submissionId = crypto.randomUUID();
  const barrier = simultaneousPreflight(db, submissionId);
  const timeout = setTimeout(barrier.release, 4000);
  try {
    const { threads, calls } = service(barrier.db, { model, retained });
    const principal = member("alice", "acme");
    const first = await threads.create(principal, { type: "chat.conversation", title: "First" });
    const second = await threads.create(principal, { type: "chat.conversation", title: "Second" });
    const outcomes = await Promise.allSettled([first, second].map((thread) =>
      threads.send(principal, { threadId: thread.id, submissionId, text: "One identity" })));
    assert.equal(barrier.count(), 2);
    await Promise.allSettled(retained.splice(0));
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1,
      "only the thread that owns the stable identity may execute");
    const rejection = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(rejection?.status === "rejected" && responseStatus(409)(rejection.reason));
    assert.equal(calls.filter((call) => call.operation === "prepare").length, 1);
    const history = await Promise.all([first, second].map((thread) => threads.entries(principal, { ref: { id: thread.id } })));
    assert.deepEqual(history.map((page) => page.entries.length).sort(), [0, 2]);
  } finally {
    clearTimeout(timeout);
    barrier.release();
    await Promise.allSettled(retained);
    client.close();
  }
});

test("creation replay survives a provider schema upgrade and retains the original version", async () => {
  const { db, client } = await threadDatabase();
  try {
    const principal = member("alice", "acme");
    const input = { id: crypto.randomUUID(), type: "chat.conversation", title: "Before upgrade" };
    const original = service(db, { model, types: conversationTypes.map((type) => ({ ...type, version: 1 })) }).threads;
    assert.equal((await original.create(principal, input)).typeVersion, 1);
    const upgraded = service(db, { model, types: conversationTypes.map((type) => ({ ...type, version: 2 })) }).threads;
    const replay = await upgraded.create(principal, input);
    assert.equal(replay.id, input.id);
    assert.equal(replay.typeVersion, 1, "a retry must not relabel existing history with the new schema version");
  } finally { client.close(); }
});

test("an immediate follow-up includes every seeded history entry", async (context) => {
  context.mock.method(Date, "now", () => 1_900_000_000_000);
  const { db, client } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  const prompts: string[] = [];
  try {
    const base = model();
    const capture = () => ({ effort: false, model: new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return base.model.doStream(options);
      },
    }) });
    const { threads } = service(db, { model: capture, retained });
    const principal = member("alice", "acme");
    const seed = ["Original guest question", "Original assistant answer", "Latest guest context"];
    const thread = await threads.create(principal, {
      type: "chat.conversation", title: "Claimed history",
      entries: seed.map((text, index) => ({ id: crypto.randomUUID(), role: index === 1 ? "assistant" as const : "user" as const, text })),
    });
    await threads.send(principal, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "Continue the conversation" });
    await Promise.all(retained.splice(0));
    assert.equal(prompts.length, 1);
    for (const text of seed) assert.ok(prompts[0].includes(text), `seed history was lost: ${text}`);
  } finally { await Promise.allSettled(retained); client.close(); }
});

test("organization-shared threads accept cross-app sends and preserve their actual actors", async () => {
  const { db, client } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  try {
    const { threads, calls } = service(db, { model, retained });
    const thread = await threads.create(member("alice", "acme"), {
      type: "chat.conversation", title: "Shared across apps", visibility: "organization",
    });
    const caller = member("bob", "acme", {
      installationId: "another-app", actor: { kind: "app", id: "another-app" }, origin: { kind: "member", id: "bob" },
    });
    await threads.send(caller, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "Use this shared conversation" });
    await Promise.all(retained.splice(0));
    const prepare = calls.find((call) => call.operation === "prepare");
    assert.equal(prepare?.installationId, "chat-app", "callbacks still route to the provider");
    assert.deepEqual(prepare?.principal.actor, caller.actor, "thread visibility must not replace the calling app's identity");
    assert.deepEqual(prepare?.principal.origin, caller.origin);
    const user = (await threads.entries(caller, { ref: thread.ref })).entries.find((entry) => entry.role === "user");
    assert.equal(user?.attribution.installationId, "another-app");
    assert.deepEqual(user?.attribution.actor, caller.actor);
    assert.deepEqual(user?.attribution.origin, caller.origin);
  } finally { await Promise.allSettled(retained); client.close(); }
});

test("a worker from a deleted thread cannot finalize over a recreated stable identity", async () => {
  const { db, client } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  let openOld!: () => void, openNew!: () => void, startedOld!: () => void, startedNew!: () => void;
  const oldGate = new Promise<void>((resolve) => { openOld = resolve; });
  const newGate = new Promise<void>((resolve) => { openNew = resolve; });
  const oldStarted = new Promise<void>((resolve) => { startedOld = resolve; });
  const newStarted = new Promise<void>((resolve) => { startedNew = resolve; });
  let turn = 0;
  const gatedModel = () => {
    const index = turn++;
    const base = model();
    return { effort: false, model: new MockLanguageModelV3({ doStream: async (options) => {
      if (index === 0) { startedOld(); await oldGate; }
      else { startedNew(); await newGate; }
      const result = await base.model.doStream(options);
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk.type === "text-delta" ? { ...chunk, delta: index === 0 ? "STALE old reply" : "Current reply" } : chunk);
        },
      })) };
    } }) };
  };
  try {
    const { threads } = service(db, { model: gatedModel, retained });
    const principal = member("alice", "acme");
    const id = crypto.randomUUID(), submissionId = crypto.randomUUID();
    await threads.create(principal, { id, type: "chat.conversation", title: "Original" });
    await threads.send(principal, { threadId: id, submissionId, text: "Old request" });
    await oldStarted;
    // Simulate a stalled worker whose lease expired, as the D1 fencing test does.
    await client.execute({ sql: "UPDATE chats SET leaseUntil=1 WHERE id=?", args: [id] });
    await threads.remove(principal, id);
    await threads.create(principal, { id, type: "chat.conversation", title: "Recreated" });
    await threads.send(principal, { threadId: id, submissionId, text: "New request" });
    await newStarted;
    openOld();
    await retained[0];
    openNew();
    await Promise.all(retained.splice(0));
    const replies = (await threads.entries(principal, { ref: { id } })).entries.filter((entry) => entry.role === "assistant");
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0].parts, [{ type: "text", text: "Current reply" }]);
  } finally {
    openOld(); openNew();
    await Promise.allSettled(retained);
    client.close();
  }
});

test("an admitted send cannot follow a recreated id into another member's private thread", async () => {
  const { db, client } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  const submissionId = crypto.randomUUID();
  const barrier = simultaneousPreflight(db, submissionId);
  const timeout = setTimeout(barrier.release, 4000);
  try {
    const plain = service(db, { model }).threads;
    const { threads, calls } = service(barrier.db, { model, retained });
    const alice = member("alice", "acme"), bob = member("bob", "acme");
    const id = crypto.randomUUID();
    await plain.create(alice, { id, type: "chat.conversation", title: "Alice's old thread" });
    const pending = threads.send(alice, { threadId: id, submissionId, text: "Alice's delayed send" });
    // Pause after Alice's authorization and empty submission preflight.
    for (let count = 0; barrier.count() < 1 && count < 100; count++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(barrier.count(), 1);
    await plain.remove(alice, id);
    await plain.create(bob, { id, type: "chat.conversation", title: "Bob's private replacement",
      entries: [{ id: crypto.randomUUID(), role: "user", text: "Bob's private source" }] });
    barrier.release();
    const outcome = await Promise.allSettled([pending]);
    await Promise.allSettled(retained.splice(0));
    assert.equal(outcome[0].status, "rejected", "the admitted row's owner must still match at lease acquisition");
    assert.equal(calls.filter((call) => call.operation === "prepare").length, 0, "no provider may run on the replacement row");
    const page = await plain.entries(bob, { ref: { id } });
    assert.equal(page.entries.length, 1);
    assert.deepEqual(page.entries[0].parts, [{ type: "text", text: "Bob's private source" }]);
  } finally {
    clearTimeout(timeout);
    barrier.release();
    await Promise.allSettled(retained);
    client.close();
  }
});

test("history reads cannot follow an admitted id into another member's private thread", async () => {
  const { db, client } = await threadDatabase();
  const id = crypto.randomUUID();
  const barrier = simultaneousPreflight(db, id, "chats");
  const timeout = setTimeout(barrier.release, 4000);
  try {
    const plain = service(db, { model }).threads;
    const reader = service(barrier.db, { model }).threads;
    const alice = member("alice", "acme"), bob = member("bob", "acme");
    await plain.create(alice, { id, type: "chat.conversation", title: "Old authorized resource" });
    const pending = reader.entries(alice, { ref: { id } });
    for (let count = 0; barrier.count() < 1 && count < 100; count++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(barrier.count(), 1, "the original visible row has been read");
    await plain.remove(alice, id);
    await plain.create(bob, { id, type: "chat.conversation", title: "Private replacement",
      entries: [{ id: crypto.randomUUID(), role: "user", text: "PRIVATE replacement history" }] });
    barrier.release();
    const [result] = await Promise.allSettled([pending]);
    if (result.status === "fulfilled")
      assert.ok(!JSON.stringify(result.value).includes("PRIVATE replacement history"), "authorization of the old resource cannot reveal the replacement's content");
    else assert.ok(responseStatus(404)(result.reason) || responseStatus(409)(result.reason));
  } finally {
    clearTimeout(timeout);
    barrier.release();
    client.close();
  }
});

test("a delayed deletion acknowledgement cannot delete a replacement's history or uploads", async () => {
  const { db, client } = await threadDatabase();
  const objects = memoryObjects();
  let acknowledge!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { acknowledge = resolve; });
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  let first = true;
  const options = { model, objects, types: conversationTypes.map((type) => ({ ...type, notify: ["deleted"] })),
    provider: async ({ operation }: { operation: string }) => {
      if (operation === "deleted" && first) { first = false; started(); await gate; }
      return undefined;
    } };
  try {
    const original = service(db, options).threads, concurrent = service(db, options).threads;
    const alice = member("alice", "acme"), bob = member("bob", "acme");
    const id = crypto.randomUUID();
    await original.create(alice, { id, type: "chat.conversation", title: "Original" });
    const pending = original.remove(alice, id);
    await waiting;
    await concurrent.remove(alice, id);
    await concurrent.create(bob, { id, type: "chat.conversation", title: "Bob's private replacement",
      entries: [{ id: crypto.randomUUID(), role: "user", text: "Keep Bob's history" }] });
    await concurrent.upload(bob, id, new Request("https://upload.test", { method: "POST",
      headers: { "Content-Type": "image/png", "X-Filename": "private.png" },
      body: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]) }));
    acknowledge();
    await Promise.allSettled([pending]);
    assert.ok(await concurrent.get(bob, { id }), "the replacement belongs to Bob and Alice cannot delete it");
    assert.equal((await concurrent.entries(bob, { ref: { id } })).entries.length, 1);
    assert.equal(objects.store.size, 1, "the old deletion cannot purge the replacement's private upload");
  } finally { acknowledge(); client.close(); }
});

for (const operation of ["update", "append"] as const) {
  test(`an admitted ${operation} cannot mutate another member's replacement thread`, async () => {
    const { db, client } = await threadDatabase();
    const id = crypto.randomUUID();
    const barrier = simultaneousPreflight(db, id, "chats");
    const timeout = setTimeout(barrier.release, 4000);
    try {
      const plain = service(db, { model }).threads;
      const delayed = service(barrier.db, { model }).threads;
      const alice = member("alice", "acme"), bob = member("bob", "acme");
      await plain.create(alice, { id, type: "chat.conversation", title: "Original" });
      const pending = operation === "update"
        ? delayed.update(alice, { threadId: id, title: "Alice's delayed rename" })
        : delayed.append(alice, { threadId: id, sourceKey: "delayed-note", role: "note", parts: [{ type: "text", text: "Alice's delayed entry" }] });
      for (let count = 0; barrier.count() < 1 && count < 100; count++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(barrier.count(), 1);
      await plain.remove(alice, id);
      await plain.create(bob, { id, type: "chat.conversation", title: "Bob's private replacement" });
      barrier.release();
      await Promise.allSettled([pending]);
      assert.equal((await plain.get(bob, { id }))?.title, "Bob's private replacement");
      assert.equal((await plain.entries(bob, { ref: { id } })).entries.length, 0,
        "a delayed provider entry may not be appended into a private replacement");
    } finally { clearTimeout(timeout); barrier.release(); client.close(); }
  });
}

test("imported assistant presentation does not falsify the verified inserting actor", async () => {
  const { db, client } = await threadDatabase();
  try {
    const { threads } = service(db, { model });
    const alice = member("alice", "acme");
    const thread = await threads.create(alice, { type: "chat.conversation", title: "Imported history",
      entries: [{ id: crypto.randomUUID(), role: "assistant", text: "Imported answer" }] });
    const [entry] = (await threads.entries(alice, { ref: { id: thread.id } })).entries;
    assert.equal(entry.role, "assistant");
    assert.deepEqual(entry.attribution.actor, alice.actor, "display role is not authenticated actor identity");
    assert.deepEqual(entry.attribution.origin, alice.origin);
  } finally { client.close(); }
});


test("accounting references distinguish recreated owners even when the clock has not advanced", async () => {
  const { db, client } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  const references: unknown[] = [];
  const threads = createThreadService({
    db, objects: memoryObjects(), now: () => 1000,
    inference: { resolve: async () => model() },
    accounting: { start: async (_principal, ref) => {
      references.push(ref);
      return { observe() {}, async settle() {} };
    } },
    providers: {
      installations: async () => ["chat-app"],
      call: async (_principal, _installation, operation) => {
        if (operation === "types") return conversationTypes;
        return operation === "prepare" ? { instructions: "Fixture app" } : { ok: true };
      },
    },
    retain: (work) => { retained.push(work); },
  });
  try {
    const alice = member("alice", "acme"), bob = member("bob", "acme");
    const id = crypto.randomUUID(), submissionId = crypto.randomUUID();
    await threads.create(alice, { id, type: "chat.conversation", title: "Reused identity", visibility: "organization" });
    // The same acting member sends both: the principal cannot distinguish these incarnations either.
    await threads.send(bob, { threadId: id, submissionId, text: "Original request" });
    await Promise.all(retained.splice(0));
    await threads.remove(alice, id);
    await threads.create(bob, { id, type: "chat.conversation", title: "Reused identity" });
    await threads.send(bob, { threadId: id, submissionId, text: "Replacement request" });
    await Promise.all(retained.splice(0));
    assert.equal(references.length, 2);
    assert.notDeepEqual(references[0], references[1],
      "metering references must distinguish the admitted owners even with identical UUIDs and timestamps");
  } finally { await Promise.allSettled(retained); client.close(); }
});

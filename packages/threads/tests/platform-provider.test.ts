import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { PlatformProvider } from "../src/types";
import { conversationTypes, member, service, threadDatabase } from "./helpers/fixture";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = () => ({
  effort: false,
  model: new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: [
      { type: "text-start" as const, id: "a" }, { type: "text-delta" as const, id: "a", delta: "Hello" }, { type: "text-end" as const, id: "a" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
    ] }) }),
  }),
});

const sidebar = { type: "platform.sidebar", version: 1, label: "Outfitter", kind: "conversation" as const, operations: ["get", "entries", "create", "send", "delete"] as ("get" | "entries" | "create" | "send" | "delete")[] };

function platform() {
  const calls: { operation: string; userId: string }[] = [];
  const provider: PlatformProvider = {
    types: [sidebar],
    async call(principal, operation) {
      calls.push({ operation, userId: principal.userId });
      return operation === "prepare" ? { instructions: "Platform sidebar" } : null;
    },
  };
  return { provider, calls };
}

test("the platform provides its own thread type: no installation, always private, answered in-process", async () => {
  const { db, client } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  try {
    const own = platform();
    const { threads, calls } = service(db, { model, retained, platform: own.provider });
    // Even acting from an app's page, an organization member's sidebar thread is theirs alone.
    const alice = member("alice", "acme", { installationId: "chat-app" });
    const thread = await threads.create(alice, { type: "platform.sidebar", title: "Outfitter", visibility: "organization", context: { type: "platform.organization", id: "acme" } });
    assert.equal(thread.installationId, null);
    assert.equal(thread.visibility, "private");

    await threads.send(alice, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "Hi" });
    await Promise.all(retained.splice(0));
    assert.deepEqual(own.calls.map((call) => call.operation), ["prepare", "finish"]);
    assert.ok(!calls.some((call) => call.operation === "prepare"), "no app is asked to prepare the reply");
    const { entries } = await threads.entries(alice, { ref: { id: thread.id }, limit: 10 });
    assert.equal(entries.at(-1)?.role, "assistant");

    // Another member of the organization never sees it.
    assert.equal(await threads.get(member("bob", "acme"), { id: thread.id }).catch(() => null), null);
  } finally { await Promise.allSettled(retained); client.close(); }
});

test("only a member's own request opens a platform thread, and an app cannot provide one", async () => {
  const { db, client } = await threadDatabase();
  try {
    const app = { userId: "alice", organizationId: null, memberContext: false, canAdminister: false, installationId: "chat-app",
      actor: { kind: "app" as const, id: "chat-app" }, origin: { kind: "member" as const, id: "alice" } };
    const own = platform();
    const withPlatform = service(db, { model, platform: own.provider }).threads;
    await assert.rejects(withPlatform.create(app, { type: "platform.sidebar", title: "Outfitter" }), (error: Response) => error.status === 403);

    // An installed app that declares a `platform.` type is never its provider.
    const appOnly = service(db, { model, types: [...conversationTypes, sidebar] }).threads;
    await assert.rejects(appOnly.create(member("alice", null), { type: "platform.sidebar", title: "Outfitter" }), (error: Response) => error.status === 409);
  } finally { client.close(); }
});

test("platform code records activity into a member's platform thread, once, and the member's own open replays it", async () => {
  const { db, client } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  try {
    const prompts: unknown[] = [];
    const recording = () => ({
      effort: false,
      model: new MockLanguageModelV3({
        doStream: async (options) => {
          prompts.push(options.prompt);
          return { stream: simulateReadableStream({ chunks: [
            { type: "text-start" as const, id: "a" }, { type: "text-delta" as const, id: "a", delta: "Seen" }, { type: "text-end" as const, id: "a" },
            { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
          ] }) };
        },
      }),
    });
    const { threads } = service(db, { model: recording, retained, platform: platform().provider });
    const id = crypto.randomUUID();
    const opened = { id, type: "platform.sidebar", visibility: "private" as const, context: { type: "platform.user", id: "alice" } };
    const activity = { sourceKey: "platform.activity:run:r1", role: "event" as const, parts: [{ type: "text" as const, text: "Daily brief finished" }] };

    const first = await threads.record({ userId: "alice", organizationId: null }, opened, activity);
    const again = await threads.record({ userId: "alice", organizationId: null }, opened, activity);
    assert.equal(again.id, first.id, "the same source key records once");

    // The member's own first open is a replay of the same thread.
    const alice = member("alice", null, { installationId: null });
    const thread = await threads.create(alice, opened);
    assert.equal(thread.id, id);
    const { entries } = await threads.entries(alice, { ref: { id }, limit: 10 });
    assert.deepEqual(entries.map((entry) => entry.role), ["event"]);
    assert.equal(entries[0]?.attribution.actor.kind, "platform");

    // The agent sees what happened.
    await threads.send(alice, { threadId: id, submissionId: crypto.randomUUID(), text: "What happened?" });
    await Promise.all(retained.splice(0));
    assert.ok(JSON.stringify(prompts[0]).includes("[event] Daily brief finished"));

    // Nobody else's thread, and only platform types.
    assert.equal(await threads.get(member("bob", null), { id }).catch(() => null), null);
    await assert.rejects(threads.record({ userId: "alice", organizationId: null }, { ...opened, id: crypto.randomUUID(), type: "chat.conversation" }, activity),
      (error: Response) => error.status === 403);
  } finally { await Promise.allSettled(retained); client.close(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { threadProvider } from "@ai-outfitter/app-sdk/threads";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { threadTestHost, workerProvider } from "../src/threads";

const finish = { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } };

test("the real thread service answers threads.* and calls the app's own provider routes", async () => {
  const seen: string[] = [];
  const app = threadProvider({
    types: () => [{ type: "fixture.conversation", version: 1, label: "Fixture", kind: "conversation", operations: ["create", "send", "delete"] }],
    async prepare(input) { seen.push(`prepare:${input.entry.parts.find((part) => part.type === "text")?.type}`); return { instructions: "Fixture" }; },
  });
  const host = await threadTestHost({
    installations: ["app"],
    model: () => new MockLanguageModelV3({ doStream: { stream: simulateReadableStream({ chunks: [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Hi" }, { type: "text-end", id: "t" }, finish] }) } }),
    provider: workerProvider((request) => app(request, new URL(request.url).pathname.split("/").at(-1) ?? "")),
  });
  const owner = host.stub({ userId: "owner", organizationId: "org", installationId: "app" });
  const member = host.stub({ userId: "member", organizationId: "org", installationId: "app" });
  const created = await owner.call("threads.create", { type: "fixture.conversation", title: "Mine" });
  assert.ok(created.ok);
  const id = (created as { value: { id: string } }).value.id;
  assert.deepEqual(await member.call("threads.get", { ref: { id } }), { ok: true, value: null }, "private by default");
  const sent = await owner.call("threads.send", { threadId: id, submissionId: crypto.randomUUID(), text: "Hello" });
  assert.ok(sent.ok);
  await host.settle();
  const page = await owner.call("threads.entries", { ref: { id } });
  assert.ok(page.ok);
  assert.deepEqual((page as { value: { entries: { role: string }[] } }).value.entries.map((entry) => entry.role), ["user", "assistant"]);
  assert.deepEqual(seen, ["prepare:text"]);
  // The browser API is the platform's own handler over the same service.
  const page2 = await host.browser({ userId: "owner", organizationId: "org", installationId: "app" })(new Request(`https://app.example/o/org/app/api/platform/threads/${id}/entries?limit=1`));
  assert.equal(page2.status, 200);
  assert.equal(((await page2.json()) as { entries: unknown[] }).entries.length, 1);
  assert.equal((await host.browser({ userId: "member", organizationId: "org", installationId: "app" })(new Request(`https://app.example/api/platform/threads/${id}`))).status, 404);
  assert.deepEqual(await owner.call("threads.append", { threadId: id, sourceKey: "k", role: "event", parts: [{ type: "status", status: "x" }] }),
    { ok: false, status: 409, message: "Thread provider unavailable" }, "append needs the type to declare it");
});

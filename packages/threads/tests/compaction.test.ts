import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { compactionCut, estimateTokens, LOW_WATER } from "../src/compaction";
import { member, service, threadDatabase } from "./helpers/fixture";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const finish = { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage };

/** A model that records each reply's prompt and answers summaries with `summary` (or fails). */
function recordingModel(summary: string | Error) {
  const prompts: unknown[][] = [];
  const summaries: string[] = [];
  const model = () => ({
    effort: false,
    model: new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt as unknown[]);
        return { stream: simulateReadableStream({ chunks: [
          { type: "text-start" as const, id: "a" }, { type: "text-delta" as const, id: "a", delta: "Reply" }, { type: "text-end" as const, id: "a" }, finish,
        ] }) };
      },
      doGenerate: async (options) => {
        summaries.push(JSON.stringify(options.prompt));
        if (summary instanceof Error) throw summary;
        return { content: [{ type: "text" as const, text: summary }], finishReason: finish.finishReason, usage, warnings: [] };
      },
    }),
  });
  return { model, prompts, summaries };
}

const row = (role: "user" | "assistant", text: string) => ({ role, content: text, parts: JSON.stringify([{ type: "text", text }]) });

test("compactionCut leaves a thread under its budget alone and otherwise cuts at a turn, down to half", () => {
  const turns = Array.from({ length: 20 }, (_, index) => [row("user", `question ${index} ${"x".repeat(400)}`), row("assistant", `answer ${index} ${"y".repeat(400)}`)]).flat();
  const current = row("user", "latest");
  const rows = [...turns, current];
  const total = rows.reduce((sum, entry) => sum + estimateTokens(entry), 0);
  assert.equal(compactionCut(rows, total + 10), null);
  const budget = Math.floor(total / 2);
  const cut = compactionCut(rows, budget);
  assert.ok(cut !== null && cut > 0);
  assert.equal(rows[cut]?.role, "user", "a cut keeps a turn and its reply together");
  const kept = rows.slice(cut).reduce((sum, entry) => sum + estimateTokens(entry), 0);
  assert.ok(kept <= budget * LOW_WATER, "the kept tail fits the low-water mark");
  assert.ok(kept + estimateTokens(rows[cut - 1] ?? current) + estimateTokens(rows[cut - 2] ?? current) > budget * LOW_WATER, "and keeps every whole turn that fits");
  // A single huge latest turn still folds everything before it.
  assert.equal(compactionCut([...turns, row("user", "z".repeat(budget * 8))], budget), turns.length);
});

test("a budgeted thread compacts once, then only grows at its end so its prefix stays cacheable", async (context) => {
  let clock = 1_900_000_000_000;
  context.mock.method(Date, "now", () => clock++);
  const { db, client } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  const recorded = recordingModel("SUMMARY: the member prefers metric units");
  try {
    const { threads } = service(db, {
      model: recorded.model, retained,
      provider: ({ operation }) => (operation === "prepare" ? { instructions: "Forever thread", history: { budget: 4_000 } } : undefined),
    });
    const alice = member("alice", null);
    const seed = Array.from({ length: 40 }, (_, index) => ({
      id: crypto.randomUUID(), role: index % 2 ? "assistant" as const : "user" as const, text: `entry ${index} ${"w".repeat(800)}`,
    }));
    const thread = await threads.create(alice, { type: "chat.conversation", title: "Forever", entries: seed });

    await threads.send(alice, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "First question" });
    await Promise.all(retained.splice(0));
    assert.equal(recorded.summaries.length, 1, "crossing the budget compacts once");
    assert.ok(recorded.summaries[0]?.includes("entry 0 "), "the summary reads the folded entries");
    const first = JSON.stringify(recorded.prompts[0]);
    assert.ok(first.includes("SUMMARY: the member prefers metric units"));
    assert.ok(!first.includes("entry 0 "), "folded entries leave the prompt");
    assert.ok(first.includes("entry 39 ") && first.includes("First question"), "recent entries stay verbatim");

    await threads.send(alice, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "Second question" });
    await Promise.all(retained.splice(0));
    assert.equal(recorded.summaries.length, 1, "under the budget again, the next turn does not compact");
    const [before, after] = recorded.prompts as unknown[][];
    assert.deepEqual(after?.slice(0, before?.length), before, "the next prompt starts with the whole previous prompt");

    const { entries } = await threads.entries(alice, { ref: { id: thread.id }, limit: 200 });
    assert.equal(entries.length, seed.length + 5, "stored entries are kept: 40 seeds, 2 turns and one checkpoint note");
    assert.equal(entries.filter((entry) => entry.role === "note").length, 1);
  } finally { await Promise.allSettled(retained); client.close(); }
});

test("a failed summary still bounds the prompt and says what it left out", async (context) => {
  let clock = 1_900_000_000_000;
  context.mock.method(Date, "now", () => clock++);
  const { db, client } = await threadDatabase();
  const retained: Promise<unknown>[] = [];
  const recorded = recordingModel(new Error("provider down"));
  try {
    const { threads } = service(db, {
      model: recorded.model, retained,
      provider: ({ operation }) => (operation === "prepare" ? { instructions: "Forever thread", history: { budget: 4_000 } } : undefined),
    });
    const alice = member("alice", null);
    const seed = Array.from({ length: 40 }, (_, index) => ({ id: crypto.randomUUID(), role: index % 2 ? "assistant" as const : "user" as const, text: `entry ${index} ${"w".repeat(800)}` }));
    const thread = await threads.create(alice, { type: "chat.conversation", title: "Forever", entries: seed });
    await threads.send(alice, { threadId: thread.id, submissionId: crypto.randomUUID(), text: "Question" });
    await Promise.all(retained.splice(0));
    const prompt = JSON.stringify(recorded.prompts[0]);
    assert.ok(prompt.includes("could not be summarized"));
    assert.ok(!prompt.includes("entry 0 "));
    const { entries } = await threads.entries(alice, { ref: { id: thread.id }, limit: 200 });
    assert.equal(entries.at(-1)?.role, "assistant", "the reply still completes");
  } finally { await Promise.allSettled(retained); client.close(); }
});

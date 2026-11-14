import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadEntry } from "@ai-outfitter/app-sdk/threads";
import { uiMessage } from "../src/react/chat/thread-messages";

const entry = (parts: ThreadEntry["parts"], status: ThreadEntry["status"] = "complete") => ({ id: "entry", role: "assistant", status, parts }) as ThreadEntry;

test("restores a card's recorded result and preserves failed or pending calls", () => {
  const message = uiMessage(entry([
    { type: "tool-call", name: "propose_tasks", callId: "card", input: {} },
    { type: "tool-result", name: "propose_tasks", callId: "card", output: { tasks: [{ id: "one" }] } },
    { type: "tool-call", name: "query", callId: "failed", input: {} },
    { type: "tool-result", name: "query", callId: "failed", error: "Unavailable", output: null },
    { type: "tool-call", name: "query", callId: "pending", input: {} },
  ], "aborted"));
  assert.deepEqual(message.parts.map((part) => "state" in part ? part.state : null), ["output-available", "output-error", "input-available"]);
  assert.deepEqual((message.parts[0] as { output: unknown }).output, { tasks: [{ id: "one" }] });
  assert.equal((message.metadata as { status: string }).status, "aborted");
});

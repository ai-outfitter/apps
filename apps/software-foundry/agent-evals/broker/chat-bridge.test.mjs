import assert from "node:assert/strict";
import test from "node:test";
import { listenBridge } from "./chat-bridge.mjs";

const secret = "b".repeat(64);
const model = "gpt-5.4";
const marker = "Execute only the implement node for box/repo.\n\nAssigned runId: 3a7e9c1d-5b2f-4e8a-9d6c-1f0b2a3c4d5e\n\nAssigned inputs: fixture";
const tools = ["read", "mcp__chrome__take_snapshot"].map(name => ({
  type: "function", function: { name, parameters: { type: "object" } },
}));
const messages = [{ role: "system", content: "Implement the requested change." }, { role: "user", content: marker }];
const nativeUsage = { input: 25, output: 9, cacheRead: 10, cacheWrite: 0, totalTokens: 44 };
const nativeCall = { type: "toolCall", id: "call_17|fc_17", name: "read", arguments: { path: "index.mjs" } };

const chat = (url, extra = {}, bearer = secret) => fetch(url + "/chat/completions", {
  method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model, stream: true, tools, messages, ...extra }),
});
const chunks = output => output.split("\n").filter(row => row.startsWith("data: {")).map(row => JSON.parse(row.slice(6)));

test("bridge streams a Pi tool call, translates its result, and reports real final usage", async t => {
  const received = [];
  const bridge = await listenBridge({ model, secret, requests: 2, async *provider(transcript) {
    received.push(transcript);
    if (received.length === 1) {
      yield { type: "toolcall_end", toolCall: nativeCall };
      yield { type: "done", message: { stopReason: "toolUse", usage: nativeUsage, content: [nativeCall] } };
    } else {
      yield { type: "text_delta", delta: "Done" };
      yield { type: "done", message: { stopReason: "stop", usage: nativeUsage, content: [{ type: "text", text: "Done" }] } };
    }
  } });
  t.after(bridge.close);
  assert.equal((await chat(bridge.url, {}, "invalid")).status, 401);
  assert.equal((await chat(bridge.url, { model: "wrong" })).status, 400);
  const first = await chat(bridge.url);
  assert.equal(first.status, 200);
  const wire = await first.text();
  const [start, tool, stop, usage] = chunks(wire);
  assert.equal(start.choices[0].delta.role, "assistant");
  const call = tool.choices[0].delta.tool_calls[0];
  assert.equal(call.id, nativeCall.id);
  assert.equal(stop.choices[0].finish_reason, "tool_calls");
  assert.equal(usage.usage.prompt_tokens, 35);
  assert.equal(usage.usage.total_tokens, 44);
  assert.match(wire, /data: \[DONE\]/);
  assert.equal((await chat(bridge.url, { messages: [{ role: "user", content: marker.replace("3a7e9c1d", "4a7e9c1d") }] })).status, 403);
  const second = await chat(bridge.url, { stream: false, messages: [
    ...messages, { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: "export const add = (a,b) => a+b;" },
  ] });
  assert.equal((await second.json()).choices[0].message.content, "Done");
  assert.equal(received[1].messages.at(-1).toolName, "read");
  assert.equal(received[1].messages.at(-1).toolCallId, nativeCall.id);
  assert.equal((await chat(bridge.url)).status, 410);
});

test("bridge neither returns provider diagnostics nor signals successful completion after an error", async t => {
  const bridge = await listenBridge({ model, secret, async *provider() {
    yield { type: "text_delta", delta: "Partial" };
    yield { type: "error", error: { errorMessage: "fixture-native-credential" } };
  } });
  t.after(bridge.close);
  assert.equal((await chat(bridge.url, { messages: [{ role: "user", content: "unbound" }] })).status, 400);
  const response = await chat(bridge.url);
  const wire = await response.text();
  assert.match(wire, /native_pi_request_failed/);
  assert.doesNotMatch(wire, /fixture-native-credential|\[DONE\]/);
});

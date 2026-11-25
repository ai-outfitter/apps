import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { createNativeProvider, privateDirectory } from "./native-pi.mjs";
import { listenBridge } from "./chat-bridge.mjs";

test("only a private external non-symlink directory is accepted", async t => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-broker-test-"));
  const alias = dir + "-alias";
  t.after(async () => { await rm(dir, { recursive: true }); await rm(alias, { force: true }); });
  assert.equal(await privateDirectory(dir), dir);
  await symlink(dir, alias);
  await assert.rejects(privateDirectory(alias), /owner-only/);
  await chmod(dir, 0o755);
  await assert.rejects(privateDirectory(dir), /owner-only/);
});

const runtimeDir = process.env.PI_BROKER_TEST_RUNTIME;
const model = "gpt-6-sol";
const marker = "Workflow 3a7e9c1d-5b2f-4e8a-9d6c-1f0b2a3c4d5e, node implement";
const secret = "c".repeat(64);
const calls = [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
const responseUsage = { input_tokens: 19, input_tokens_details: { cached_tokens: 5 }, output_tokens: 7, total_tokens: 26 };
const item = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "read", arguments: '{"path":"index.mjs"}' };
const sse = (...events) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
  { headers: { "Content-Type": "text/event-stream" } });

test("Pi 1.0.4 uses its native OAuth SSE transport with a fake provider and a real tool round trip", { skip: !runtimeDir }, async t => {
  const authDir = await mkdtemp(join(tmpdir(), "foundry-pi-mock-"));
  t.after(() => rm(authDir, { recursive: true }));
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url");
  const bearer = `fixture.${payload}.fixture`;
  await writeFile(join(authDir, "auth.json"), JSON.stringify({ "openai-codex": {
    type: "oauth", access: "expired-fixture", refresh: "fixture-refresh", expires: 1,
  } }), { mode: 0o600 });
  const realFetch = globalThis.fetch;
  let refreshes = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://auth.openai.com/oauth/token") {
      refreshes++;
      assert.equal(init.method, "POST");
      assert.match(String(init.body), /fixture-refresh/);
      return Response.json({ access_token: bearer, refresh_token: "fixture-rotation", expires_in: 3600 });
    }
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:/, "the synthetic test must not contact an external service");
    return realFetch(url, init);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const recorded = [];
  const provider = await createNativeProvider({ runtimeDir, authDir, model, async fetch(url, init) {
    assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${bearer}`);
    const body = headers.get("Content-Encoding") === "zstd" ? zstdDecompressSync(init.body).toString("utf8") : init.body;
    const parsed = JSON.parse(body);
    assert.equal(parsed.model, model);
    assert.equal(parsed.store, false);
    recorded.push(parsed);
    if (recorded.length === 1) return sse(
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed", usage: responseUsage } },
    );
    const message = { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: "Read complete." }] };
    return sse(
      { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
      { type: "response.output_text.delta", output_index: 0, delta: "Read complete." },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { status: "completed", usage: responseUsage } },
    );
  } });
  const bridge = await listenBridge({ provider, model, secret });
  t.after(bridge.close);
  const initial = [{ role: "user", content: marker }];
  const request = messages => fetch(bridge.url + "/chat/completions", { method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools: calls, stream: true, stream_options: { include_usage: true } }),
  });
  const first = await request(initial);
  const wire = await first.text();
  assert.equal(first.status, 200, wire);
  assert.ok(!wire.includes(bearer));
  const call = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
    .flatMap(chunk => chunk.choices?.flatMap(choice => choice.delta?.tool_calls ?? []) ?? [])[0];
  assert.equal(call?.function.name, "read");
  const packageRoot = join(runtimeDir, "node_modules/@earendil-works/pi-ai/dist");
  const [{ stream }, { normalizeContext }] = await Promise.all([
    import(join(packageRoot, "api/openai-completions.js")),
    import(join(packageRoot, "utils/transcript.js")),
  ]);
  const workspaceModel = {
    id: model, provider: "workspace", api: "openai-completions", baseUrl: bridge.url,
    contextWindow: 128000, maxTokens: 8192, input: ["text"], reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false },
  };
  const next = await stream(workspaceModel, normalizeContext({
    tools: calls.map(({ function: tool }) => tool),
    messages: [{ ...initial[0], timestamp: 1 },
      { role: "assistant", provider: "workspace", model, api: "openai-completions", stopReason: "toolUse",
        content: [{ type: "toolCall", id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) }], timestamp: 2 },
      { role: "toolResult", toolCallId: call.id, toolName: "read",
        content: [{ type: "text", text: "export const add = (a, b) => a + b;" }], isError: false, timestamp: 3 }],
  }), { apiKey: secret }).result();
  assert.equal(next.stopReason, "stop", next.errorMessage);
  assert.equal(next.content[0].text, "Read complete.");
  assert.equal(next.usage.totalTokens, 26);
  assert.equal(next.usage.input + next.usage.cacheRead, 19);
  assert.equal(refreshes, 1);
  assert.ok((await readFile(join(authDir, "auth.json"), "utf8")).includes("fixture-rotation"));
  assert.ok(!JSON.stringify(recorded).includes(bearer));
  assert.ok(recorded[1].input.some(entry => entry.type === "function_call_output" && entry.call_id === "call_fixture"));
});

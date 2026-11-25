import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";

const codingTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const bodyLimit = 512 * 1024;
const responseLimit = 128 * 1024;
const workflowMarker = /^Workflow ([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}), node [a-z0-9-]+$/;
const statusError = (status) => Object.assign(Error("Invalid fixture request"), { status });
const record = value => value && typeof value === "object" && !Array.isArray(value);
const textContent = text => ({ type: "text", text });

function text(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.every(part => part?.type === "text" && typeof part.text === "string"))
    return content.map(part => part.text).join("\n");
  throw statusError(400);
}

function context(input, model) {
  if (!record(input) || input.model !== model || !Array.isArray(input.messages) || input.messages.length > 128 ||
    (input.n !== undefined && input.n !== 1) || (input.stream !== undefined && typeof input.stream !== "boolean") ||
    input.response_format || input.functions || input.function_call) throw statusError(400);
  const tools = input.tools ?? [];
  if (!Array.isArray(tools) || tools.length > codingTools.size) throw statusError(400);
  const names = new Set();
  const declarations = tools.map(tool => {
    const { name, description, parameters } = tool?.function ?? {};
    if (tool?.type !== "function" || !codingTools.has(name) || names.has(name) || !record(parameters)) throw statusError(400);
    names.add(name);
    return { name, description: typeof description === "string" ? description : "", parameters };
  });
  const messages = [];
  const system = [];
  const pending = new Map();
  let workflowRun;
  for (const message of input.messages) {
    if (!record(message)) throw statusError(400);
    const { role, content } = message;
    const timestamp = Date.now();
    if (role === "system" || role === "developer") {
      if (messages.length) throw statusError(400);
      system.push(text(content));
    } else if (role === "user") {
      if (pending.size) throw statusError(400);
      const value = text(content);
      const run = workflowMarker.exec(value.trim())?.[1];
      if (run && workflowRun && run !== workflowRun) throw statusError(400);
      workflowRun ??= run;
      messages.push({ role, content: value, timestamp });
    } else if (role === "assistant") {
      if (pending.size) throw statusError(400);
      const parts = content == null ? [] : [textContent(text(content))];
      if (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 8))
        throw statusError(400);
      for (const call of message.tool_calls ?? []) {
        const { id, function: fn } = call ?? {};
        if (call?.type !== "function" || typeof id !== "string" || !id || id.length > 256 ||
          pending.has(id) || !names.has(fn?.name) || typeof fn.arguments !== "string") throw statusError(400);
        let args;
        try { args = JSON.parse(fn.arguments); } catch { throw statusError(400); }
        if (!record(args)) throw statusError(400);
        pending.set(id, fn.name);
        parts.push({ type: "toolCall", id, name: fn.name, arguments: args });
      }
      messages.push({ role, content: parts, provider: "openai-codex", api: "openai-codex-responses", model,
        stopReason: pending.size ? "toolUse" : "stop", timestamp });
    } else if (role === "tool") {
      const name = pending.get(message.tool_call_id);
      if (!name) throw statusError(400);
      pending.delete(message.tool_call_id);
      messages.push({ role: "toolResult", toolCallId: message.tool_call_id, toolName: name,
        content: [textContent(text(content))], isError: false, timestamp });
    } else throw statusError(400);
  }
  if (!workflowRun || pending.size || !["user", "toolResult"].includes(messages.at(-1)?.role)) throw statusError(400);
  return { workflowRun, transcript: { systemPrompt: system.join("\n\n"), messages, tools: declarations } };
}

const toolCall = call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } });
const finishes = { stop: "stop", length: "length", toolUse: "tool_calls" };
const usage = value => value && ({
  prompt_tokens: value.input + value.cacheRead + value.cacheWrite,
  completion_tokens: value.output,
  total_tokens: value.totalTokens,
  prompt_tokens_details: { cached_tokens: value.cacheRead },
});
const json = (res, status, body) => res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  .end(JSON.stringify(body));
const failure = (res, status, code) => json(res, status, { error: { type: "fixture_broker", code, message: code } });

async function requestJSON(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > bodyLimit) throw statusError(413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw statusError(400); }
}

/** One serialized, expiring fixture grant. The provider is the only component
 * that handles personal auth. This HTTP server never receives those credentials. */
export async function listenBridge({ model, secret, provider, port = 0, lifetimeMs = 10 * 60_000, requests = 20 }) {
  if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret) || !Number.isInteger(lifetimeMs) ||
    lifetimeMs < 1 || lifetimeMs > 10 * 60_000 || !Number.isInteger(requests) || requests < 1 || requests > 20)
    throw Error("Invalid fixture grant");
  const deadline = Date.now() + lifetimeMs;
  const bearer = Buffer.from(`Bearer ${secret}`);
  let active;
  let boundRun;
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== bearer.length || !timingSafeEqual(supplied, bearer)) return failure(res, 401, "unauthorized");
    if (Date.now() >= deadline || requests < 1) return failure(res, 410, "fixture_grant_expired");
    if (req.url === "/v1/models" && req.method === "GET")
      return json(res, 200, { object: "list", data: [{ object: "model", id: model, owned_by: "openai-codex" }] });
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") return failure(res, 404, "not_found");
    if (active) return failure(res, 429, "fixture_request_in_progress");

    const controller = new AbortController();
    active = controller;
    const cancel = () => controller.abort();
    res.once("close", cancel);
    const timeout = setTimeout(cancel, Math.min(120_000, deadline - Date.now()));
    const signal = controller.signal;
    let code = "invalid_fixture_request";
    try {
      const input = await requestJSON(req);
      const { workflowRun, transcript } = context(input, model);
      if (boundRun && boundRun !== workflowRun) throw statusError(403);
      boundRun ??= workflowRun;
      if (signal.aborted) throw Error("Request expired");
      requests--;
      code = "native_pi_request_failed";
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const envelope = { id, created, model };
      const stream = (delta, reason = null) =>
        emit({ ...envelope, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: reason }] });
      async function emit(item) {
        if (!res.write(`data: ${JSON.stringify(item)}\n\n`)) await once(res, "drain", { signal });
      }
      let result;
      let size = 0;
      let toolIndex = 0;
      const allowedTools = new Set(transcript.tools.map(tool => tool.name));
      for await (const event of await provider(transcript, signal)) {
        if (signal.aborted || event.type === "error") throw Error("Native stream ended");
        if (event.type === "done") {
          result = event.message;
          break;
        }
        if (event.type !== "text_delta" && event.type !== "toolcall_end") continue;
        if (event.type === "toolcall_end" && !allowedTools.has(event.toolCall?.name)) throw Error("Invalid native tool");
        const delta = event.type === "text_delta" ? { content: event.delta }
          : { tool_calls: [{ index: toolIndex++, ...toolCall(event.toolCall) }] };
        size += Buffer.byteLength(JSON.stringify(delta));
        if (size > responseLimit) throw Error("Native response exceeds fixture limit");
        if (input.stream) {
          if (!res.headersSent) {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
            await stream({ role: "assistant" });
          }
          await stream(delta);
        }
      }
      if (!result || !finishes[result.stopReason]) throw Error("No completed native response");
      const calls = result.content.filter(part => part.type === "toolCall");
      if (calls.some(call => !allowedTools.has(call.name))) throw Error("Invalid native tool");
      const content = result.content.filter(part => part.type === "text").map(part => part.text).join("");
      if (Buffer.byteLength(content + JSON.stringify(calls)) > responseLimit) throw Error("Native response exceeds fixture limit");
      const finalUsage = usage(result.usage);
      const finish = finishes[result.stopReason];
      if (input.stream) {
        if (!res.headersSent) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
          await stream({ role: "assistant" });
        }
        await stream({}, finish);
        if (finalUsage) await emit({ ...envelope, object: "chat.completion.chunk", choices: [], usage: finalUsage });
        res.end("data: [DONE]\n\n");
      } else {
        const message = { role: "assistant", content: content || null, ...(calls.length && { tool_calls: calls.map(toolCall) }) };
        json(res, 200, { ...envelope, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }], usage: finalUsage });
      }
    } catch (error) {
      if (res.destroyed) return;
      const status = signal.aborted ? 504 : (code === "invalid_fixture_request" ? error.status ?? 400 : 502);
      const publicCode = signal.aborted ? "fixture_request_expired" : code;
      if (res.headersSent) {
        // No successful terminal chunk follows an upstream error.
        res.end(`data: ${JSON.stringify({ error: { message: publicCode, code: publicCode } })}\n\n`);
      } else failure(res, status, publicCode);
    } finally {
      clearTimeout(timeout);
      res.removeListener("close", cancel);
      controller.abort();
      active = undefined;
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const close = () => { active?.abort(); server.close(); server.closeAllConnections(); };
  const expiry = setTimeout(close, Math.max(1, deadline - Date.now()));
  expiry.unref();
  server.on("close", () => clearTimeout(expiry));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close };
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { api, credentials, repoPath } from "./fixture.mjs";

const model = "GLM-5.3-Flash-EXL3";
const content = "# Synthetic lamp\n\nSetting: amber.\n";
const name = "/out/provider-context.json";
const usage = { prompt_tokens: 101, completion_tokens: 23, total_tokens: 124 };
let sequence = 0;

const digest = value => createHash("sha256").update(value).digest("hex");
const record = entry => appendFileSync("/out/provider.jsonl", JSON.stringify(entry) + "\n");

function activeAttempt(context) {
  const db = new DatabaseSync(context.database, { readOnly: true });
  db.exec("PRAGMA busy_timeout=5000");
  try {
    const rows = db.prepare(`SELECT r.id AS runId, a.id AS attemptId, a.nodeId FROM workflow_runs r
      JOIN workflow_node_attempts a ON a.runId = r.id WHERE r.installationId = ? AND r.workflowId = ?
      AND r.status = 'running' AND a.state IN ('pending', 'dispatching', 'dispatched', 'running')`)
      .all(context.installationId, context.workflowId);
    assert.equal(rows.length, 1, "Model traffic belongs to one active approved workspace attempt");
    return rows[0];
  } finally { db.close(); }
}

function reply(res, body, id, output, tool) {
  const base = { id, created: 1, model };
  const finish = tool ? "tool_calls" : "stop";
  const toolCall = tool && { id: `call_${id}`, type: "function",
    function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } };
  if (!body.stream) {
    const message = { role: "assistant", ...(toolCall ? { content: null, tool_calls: [toolCall] } : { content: output }) };
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }], usage }));
    return;
  }
  const frame = (delta, finish_reason = null) => ({ ...base, object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason }] });
  const delta = { role: "assistant", ...(toolCall ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: output }) };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of [frame(delta), frame({}, finish), { ...base, object: "chat.completion.chunk", choices: [], usage }]) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

async function barrier(role, evidence) {
  if (!existsSync("/out/model-hold") || readFileSync("/out/model-hold", "utf8") !== role ||
      existsSync("/out/model-held.json")) return;
  writeFileSync("/out/model-held.json", JSON.stringify(evidence));
  const deadline = Date.now() + 45_000;
  while (!existsSync("/out/model-release") && Date.now() < deadline) await sleep(40);
  assert.ok(existsSync("/out/model-release"), "Model response barrier released");
}

export async function provider(req, res) {
  if (req.method === "GET" && req.url === "/v1/models") {
    return res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") return res.writeHead(404).end();
  const attempt = ++sequence;
  let evidence = { attempt };
  try {
    const raw = Buffer.concat(await Array.fromAsync(req));
    assert.ok(raw.length < 512 * 1024);
    const body = JSON.parse(raw);
    const context = JSON.parse(readFileSync(name, "utf8"));
    const { runId, attemptId, nodeId: actor } = activeAttempt(context);
    const messages = JSON.stringify(body.messages);
    evidence = { ...evidence, runId, attemptId, actor, model: body.model, requestSha256: digest(raw) };
    record({ ...evidence, event: "request", roles: body.messages.map(message => message.role),
      pinnedBaseInPrompt: messages.includes(context.pin.baseSha) });
    assert.ok(["implement", "review"].includes(actor));
    assert.equal(body.model, model);
    assert.ok(messages.includes(context.pin.baseSha), "Actor received the pinned base");
    if (context.currentIssue && actor === "implement") {
      assert.ok(messages.includes(context.currentIssue), "Implementer received the edited issue text");
      assert.ok(!messages.includes(context.originalIssue), "The saved original text was absent from the new prompt");
    }
    const selectedContent = context.currentContent ?? content;
    let expected = context.pin.baseSha;
    if (actor === "review") {
      const auth = credentials({ env: {} });
      const pulls = await api(auth.admin, `${repoPath}/pulls?state=open`);
      assert.equal(pulls.length, 1);
      expected = pulls[0].head.sha;
      assert.ok(messages.includes(expected), "Reviewer received the pinned PR SHA");
    }
    const toolResult = body.messages.findLast(message => message.role === "tool");
    let shaCommand = "cd repo && git rev-parse HEAD && ! git symbolic-ref -q HEAD && test -z \"$(git remote)\" && printf 'NO_REMOTE\\n' && git show HEAD:README.md";
    if (actor === "review") {
      assert.match(context.pin.baseSha, /^[0-9a-f]{40}$/);
      shaCommand += ` && git cat-file -e '${context.pin.baseSha}^{commit}' && printf 'BASE_PRESENT\\n'`;
    }
    if (!toolResult) {
      const names = body.tools?.map(item => item.function?.name) ?? [];
      assert.ok(names.includes("bash"), "Runtime exposes the workspace shell tool");
      reply(res, body, `fixture-${attempt}`, null, { name: "bash", arguments: { command: shaCommand } });
      record({ ...evidence, event: "checkout-probe", expected });
      return;
    }
    const readback = typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content);
    assert.ok(readback.includes(expected) && readback.includes("NO_REMOTE"), "Native detached checkout at exact SHA with no Git remote");
    assert.ok(readback.includes(actor === "review" ? selectedContent.trim().split("\n").at(-1) : "# Synthetic lamp"));
    if (actor === "review") assert.ok(readback.includes("BASE_PRESENT"));
    const result = actor === "implement"
      ? { summary: "Checked the exact base README.", files: [{ path: "README.md", content: selectedContent }] }
      : { headSha: expected, verdict: "approved", summary: context.currentIssue
        ? "Read README from the exact candidate commit and confirmed teal."
        : "Read README from the exact candidate commit and confirmed amber." };
    const output = JSON.stringify({ outputs: { result } });
    await barrier(actor, { ...evidence, checkout: expected });
    reply(res, body, `fixture-${attempt}`, output);
    record({ ...evidence, event: "response", checkout: expected, usage, responseSha256: digest(output) });
  } catch (error) {
    record({ ...evidence, event: "error", reason: error.message });
    if (!res.headersSent) res.writeHead(422, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { message: "Deterministic fixture refused the inference request" } }));
  }
}

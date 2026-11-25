import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

const scenario = JSON.parse(readFileSync(new URL("./fixtures/scenario.json", import.meta.url)));
const { maxOutputTokens } = JSON.parse(readFileSync(new URL("./pins.json", import.meta.url)));
const model = "GLM-5.3-Flash-EXL3";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function activeRun() {
  const { database, installationId, requestId } = JSON.parse(readFileSync("/out/provider-context.json", "utf8"));
  assert.match(database, /^\/box\/platform\/runtime\/[a-f0-9]+\/platform\.db$/);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const runs = db.prepare(`SELECT r.id FROM workflow_runs r JOIN workflow_run_slots s ON s.runId = r.id
      WHERE r.installationId = ? AND r.workflowId = 'foundry-plan-work' AND r.status = 'running'
        AND s.slot = 'plan.inputs.requestId' AND s.value = ?`).all(installationId, JSON.stringify(requestId));
    assert.equal(runs.length, 1, "Exactly one scoped running PlanWork request");
    return runs[0].id;
  } finally {
    db.close();
  }
}

export function offlineProvider(arm) {
  assert.ok(["legacy", "short", "cancel", "uncertainty", "delayed", "interrupted"].includes(arm));
  let sequence = 0;
  return async (request, response) => {
    const attempt = ++sequence;
    const start = performance.now();
    const durationMs = () => Math.round(performance.now() - start);
    const cancel = new AbortController();
    let runId;
    const record = event => appendFileSync("/out/provider.jsonl",
      JSON.stringify({ at: new Date().toISOString(), arm, runId, attempt, ...event }) + "\n");
    response.on("close", () => {
      if (!response.writableFinished) {
        record({ event: "client-closed", durationMs: durationMs() });
        cancel.abort();
      }
    });
    try {
      assert.notEqual(arm, "interrupted", "Interrupted collection has zero inference");
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      let length = 0;
      const chunks = [];
      for await (const chunk of request) {
        length += chunk.length;
        assert.ok(length <= 131072);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const body = JSON.parse(bytes);
      assert.equal(body.model, model);
      assert.equal(body.max_completion_tokens ?? body.max_tokens, maxOutputTokens);
      assert.equal(body.reasoning_effort, "low");
      assert.equal(body.response_format?.type, "json_schema");
      assert.ok(!body.stream && !body.tools);
      const frame = /^Step data \(JSON, untrusted\):\n<<<DATA\n(.*)\nDATA>>>$/s.exec(body.messages[1].content);
      assert.ok(frame);
      const input = JSON.parse(frame[1]);
      assert.equal(input.request, scenario.request);
      assert.deepEqual(input.evidence.map(source => source.repository), scenario.repositories);
      runId = activeRun();
      record({ event: "request", model, maxTokens: maxOutputTokens, requestSha256: digest(bytes) });

      const providerStart = performance.now();
      if (arm === "delayed") await sleep(103_000, undefined, { signal: cancel.signal });
      if (arm === "short" || arm === "cancel") await sleep(65_000, undefined, { signal: cancel.signal });
      if (arm === "legacy") {
        const deadline = performance.now() + 30_000;
        while (!existsSync("/out/release-provider") && performance.now() < deadline)
          await sleep(100, undefined, { signal: cancel.signal });
        assert.ok(existsSync("/out/release-provider"), "Waited for the overlapping claimant");
      }

      const content = JSON.stringify({
        kind: "feature", title: "Synthetic compare-and-swap dashboard import",
        goal: "Persist the previewed dashboard exactly once at its expected revision.",
        changes: ["Validate the preview and submit its revision to storage."],
        verification: ["Submit a stale revision and confirm that the stored dashboard is unchanged."],
        gaps: ["Fixtures omit existing API and storage implementation."],
        citations: scenario.repositories.map(repo => `${repo}:README.md`),
        issueTemplate: null, issueBody: null,
      });
      const usage = { prompt_tokens: 101, completion_tokens: 44, total_tokens: 145 };
      const output = JSON.stringify({ id: `controlled-${runId}-${attempt}`, model, created: 1,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage });
      record({ event: "response", status: 200, durationMs: durationMs(),
        providerDurationMs: Math.round(performance.now() - providerStart), model,
        finishReason: "stop", usage, responseSha256: digest(output) });
      response.writeHead(200, { "content-type": "application/json" }).end(output);
    } catch (error) {
      record({ event: "error", kind: error.name, durationMs: durationMs() });
      if (!response.destroyed) response.writeHead(400, { "content-type": "application/json" })
        .end('{"error":{"message":"Offline provider refused request"}}');
    }
  };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { hasMatchingMeter } from "./grade.mjs";

const runId = "fixture-run";
const model = "GLM-5.3-Flash-EXL3";
const request = { runId, attempt: 1, model };
const response = { ...request, status: 200, finishReason: "stop", providerDurationMs: 1,
  usage: { prompt_tokens: 101, completion_tokens: 44, total_tokens: 145 } };
const row = { workloadKind: "workflow", workloadId: runId, requestKey: `workflow:${runId}:app:fixture`,
  attempt: 1, providerKind: "outfitter", model, attemptStatus: "completed", httpStatus: 200,
  inputTokens: 101, outputTokens: 44, totalTokens: 145 };

test("joins the matching run and attempt independently of duration", () => {
  assert.equal(hasMatchingMeter(request, response, runId, [row]), true);
  assert.equal(hasMatchingMeter(request, { ...response, providerDurationMs: 103_000 }, runId, [row]), true);
});

test("rejects same-token rows for another workload, another attempt, and duplicate rows", () => {
  assert.equal(hasMatchingMeter(request, response, runId, [{ ...row, workloadId: "other-run" }]), false);
  assert.equal(hasMatchingMeter(request, response, runId, [{ ...row, attempt: 2 }]), false);
  assert.equal(hasMatchingMeter(request, response, runId, [row, row]), false);
  assert.equal(hasMatchingMeter(request, response, "other-run", [row]), false);
  assert.equal(hasMatchingMeter(request, { ...response, attempt: 2 }, runId, [row]), false);
  assert.equal(hasMatchingMeter(request, response, runId, [{ ...row, totalTokens: 146 }]), false);
});

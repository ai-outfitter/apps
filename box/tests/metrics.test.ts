import assert from "node:assert/strict";
import test from "node:test";
import { runMetrics, stepMetrics } from "../metrics.mjs";
import { metricsTable } from "../eval/agent.ts";

test("steps count their time, model calls and tokens", () => {
  const step = stepMetrics({ name: "implement", status: "succeeded", startedAt: 1_000, finishedAt: 61_000,
    calls: [{ input: 1200, output: 300 }, { input: 800, output: 300 }] });
  assert.deepEqual(step, { name: "implement", status: "succeeded", seconds: 60, modelCalls: 2, inputTokens: 2000, outputTokens: 600 });
  assert.equal(stepMetrics({ name: "check", status: "succeeded", startedAt: 0, finishedAt: 5_000 }).outputTokens, 0);
  // A call whose provider reported no tokens makes the step's total unknown, not zero.
  assert.equal(stepMetrics({ name: "review", status: "failed", startedAt: 0, finishedAt: 1, calls: [{ input: 5, output: null }] }).outputTokens, null);
});

test("a run totals its steps; tokens per second use only the model's time", () => {
  const steps = [
    stepMetrics({ name: "implement", status: "succeeded", startedAt: 0, finishedAt: 60_000, calls: [{ input: 2000, output: 600 }] }),
    stepMetrics({ name: "check", status: "succeeded", startedAt: 60_000, finishedAt: 120_000 }),
  ];
  const metrics = runMetrics(steps, { startedAt: "2026-11-07T10:00:00.000Z", finishedAt: "2026-11-07T10:03:00.000Z" });
  assert.equal(metrics.wallSeconds, 180);
  assert.equal(metrics.modelSeconds, 60);
  assert.equal(metrics.modelCalls, 1);
  assert.equal(metrics.inputTokens, 2000);
  assert.equal(metrics.outputTokensPerSecond, 10);
  assert.equal(runMetrics([], { startedAt: "2026-11-07T10:00:00.000Z", finishedAt: "2026-11-07T10:00:01.000Z" }).outputTokensPerSecond, null);
});

test("the eval table lines up each run's model and metrics", () => {
  const table = metricsTable([
    { eval: "subtract-helper", success: true, status: "landed", model: { provider: "luna", id: "gpt-6-luna" }, durationSeconds: 190,
      metrics: { wallSeconds: 180, modelSeconds: 60, modelCalls: 3, inputTokens: 2000, outputTokens: 600, outputTokensPerSecond: 10 } },
    { eval: "subtract-helper", success: false, status: "failed", model: { provider: "spark", id: "GLM-5.3-Flash-EXL3" }, durationSeconds: 400 },
  ]).split("\n");
  assert.equal(table.length, 3);
  assert.match(table[1], /luna\/gpt-6-luna\s+pass\s+180\s+60\s+3\s+2000\s+600\s+10/);
  assert.match(table[2], /spark\/GLM-5.3-Flash-EXL3\s+fail \(failed\)\s+400\s+–/);
});

test("evals that score geometry add the parts' IoU, Chamfer distance and watertightness", () => {
  const table = metricsTable([
    { eval: "cable-clip", success: true, status: "designed", model: { provider: "luna", id: "gpt-6-luna" }, durationSeconds: 20,
      geometry: { "cable-clip": { iou: 0.99, chamferMm: 0.01, watertight: true } } },
    { eval: "l-bracket", success: false, status: "failed", model: { provider: "luna", id: "gpt-6-luna" }, durationSeconds: 30 },
  ]).split("\n");
  assert.match(table[0], /IoU\s+chamfer mm\s+watertight$/);
  assert.match(table[1], /0\.99\s+0\.01\s+yes\s*$/);
  assert.match(table[2], /–\s+–\s+–\s*$/);
});

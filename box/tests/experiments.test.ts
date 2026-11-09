import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gradeCounts, writeRunRecord } from "../eval/experiments.ts";

test("grade counts come from vitest's Tests line", () => {
  assert.deepEqual(gradeCounts("x\n      Tests  6 passed (6)\n"), { passed: 6, total: 6 });
  assert.deepEqual(gradeCounts("      Tests  3 failed | 3 passed (6)"), { passed: 3, total: 6 });
  assert.equal(gradeCounts("no report"), undefined);
});

test("a run is recorded beside its grade and result, and indexed newest first", () => {
  const runs = mkdtempSync(join(tmpdir(), "box-runs-"));
  try {
    const base = { eval: "new-astro-app", box: "foundry-box", image: { ref: "outfitter/software-foundry-box:dev" }, durationSeconds: 600 };
    writeRunRecord(runs, { ...base, runId: "2026-11-09T12-00-00-000Z-new-astro-app", status: "landed", success: true,
      model: { provider: "luna", id: "gpt-6-luna" }, grade: { passed: 6, total: 6 }, metrics: { wallSeconds: 609.5, modelCalls: 163, inputTokens: 5_008_611, outputTokens: 22_688 },
      volume: "foundry-box-2026-11-09t12-00-00-000z-new-astro-app", evalOutput: "\x1b[32m✓\x1b[0m Tests  6 passed (6)", result: { status: "landed" } });
    writeRunRecord(runs, { ...base, runId: "2026-11-08T12-00-00-000Z-new-astro-app", status: "changes_requested", success: false });
    const index = readFileSync(join(runs, "README.md"), "utf8");
    assert.ok(index.indexOf("2026-11-09") < index.indexOf("2026-11-08"), "newest first");
    assert.match(index, /\| luna \/ gpt-6-luna \| landed \| 6\/6 \| pass \| 609\.5 \| 163 \| 5M \| 22\.7k \| `foundry-box-2026-11-09t12-00-00-000z-new-astro-app` \|/);
    const run = join(runs, "2026-11-09T12-00-00-000Z-new-astro-app");
    assert.equal(readFileSync(join(run, "eval.txt"), "utf8"), "✓ Tests  6 passed (6)", "colour codes are stripped");
    assert.equal(JSON.parse(readFileSync(join(run, "run.json"), "utf8")).evalOutput, undefined);
    assert.deepEqual(JSON.parse(readFileSync(join(run, "result.json"), "utf8")), { status: "landed" });
  } finally {
    rmSync(runs, { recursive: true, force: true });
  }
});

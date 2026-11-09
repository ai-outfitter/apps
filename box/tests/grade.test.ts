import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { grade } from "../eval/agent.ts";

const fixture = fileURLToPath(new URL("../../apps/workshop/agent-evals/evals/mounting-plate", import.meta.url));

test("grading gives EVAL.ts the geometry scorer and the reference, and returns its scores", () => {
  const tree = join(mkdtempSync(join(tmpdir(), "grade-")), "final");
  mkdirSync(join(tree, "designs", "mounting-plate"), { recursive: true });
  // The reference itself stands in for the box's export.
  cpSync(join(fixture, "reference", "model.stl"), join(tree, "designs", "mounting-plate", "model.stl"));
  const result = grade(fixture, tree);
  assert.equal(result.success, true, result.output);
  assert.equal(result.geometry["mounting-plate"].iou, 1);
  assert.equal(result.geometry["mounting-plate"].watertight, true);
});

test("the box agent runs one box at a time", async () => {
  const { boxAgent } = await import("../eval/agent.ts");
  // A container CLI that records when each run starts and ends.
  const dir = mkdtempSync(join(tmpdir(), "serial-"));
  const cli = join(dir, "cli.sh");
  const { writeFileSync, chmodSync, readFileSync } = await import("node:fs");
  writeFileSync(cli, `#!/bin/sh\n[ "$1" = run ] && case "$*" in *--entrypoint*) exit 0;; esac\n[ "$1" = run ] && { echo start >> ${dir}/log; sleep 0.3; echo end >> ${dir}/log; }\nexit 0\n`);
  chmodSync(cli, 0o755);
  const agent = boxAgent({ name: "t", displayName: "T", cli, image: "x", inspectPort: 1 },
    { requestFromPrompt: () => ({ requestId: crypto.randomUUID() }), succeeded: () => true });
  const options = { prompt: "x", timeout: 10_000 } as never;
  await Promise.all([agent.run(fixture, options), agent.run(fixture, options)]);
  assert.deepEqual(readFileSync(join(dir, "log"), "utf8").trim().split("\n"), ["start", "end", "start", "end"]);
});

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { grade } from "../eval/agent.ts";

const fixture = fileURLToPath(new URL("../../apps/workshop/box/evals/evals/mounting-plate", import.meta.url));

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

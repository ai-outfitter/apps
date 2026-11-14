import { join } from "node:path";
import { expect, test } from "vitest";
import { recordScore, scoreGeometry } from "@ai-outfitter/box/geometry";

// The repository the box left on its default branch.
const design = join(import.meta.dirname, "designs", "flanged-bushing");

// Scored as text-to-CAD benchmarks score a part (box/eval/geometry.ts): the
// exported STL against the OpenSCAD reference in reference/, kept rendered as
// reference/model.stl. Position and which face it stands on do not count.
const score = scoreGeometry(join(design, "model.stl"), join(import.meta.dirname, "reference", "model.stl"));
recordScore("flanged-bushing", score);

test("the exported STL is a valid, watertight solid", () => {
  expect(score.runs, score.error).toBe(true);
  expect(score.candidate).toMatchObject({ valid: true, watertight: true });
});

test("its shape matches the reference part", () => {
  expect(score.iou).toBeGreaterThanOrEqual(0.95);
  // No surface more than half a millimetre from where the reference has it: a missing or wrong-sized hole fails.
  expect(score.hausdorffMm).toBeLessThanOrEqual(0.5);
});

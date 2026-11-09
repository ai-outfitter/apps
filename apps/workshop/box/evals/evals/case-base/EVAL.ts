import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { recordScore, scoreGeometry } from "@ai-outfitter/box/geometry";

// The repository the box left on its default branch.
const design = join(import.meta.dirname, "designs", "case-base");
const json = (name: string) => JSON.parse(readFileSync(join(design, name), "utf8"));
const near = (value: number, target: number, tolerance = 1) => Math.abs(value - target) <= tolerance;

test("the design is a 224 x 178 x 9 mm body", () => {
  const [body] = json("bom.json");
  const [a, b, c] = [body.bounds.width, body.bounds.depth, body.bounds.height].sort((x: number, y: number) => x - y);
  expect(near(a, 9) && near(b, 178) && near(c, 224)).toBe(true);
});

test("the STEP and STL models were exported", () => {
  expect(readFileSync(join(design, "model.step"), "utf8").startsWith("ISO-10303-21")).toBe(true);
  expect(readFileSync(join(design, "model.stl")).length).toBeGreaterThan(84);
});

// Scored as text-to-CAD benchmarks score a part (box/eval/geometry.ts): the
// exported STL against the OpenSCAD reference in reference/, kept rendered as
// reference/model.stl. Position and which face it stands on do not count.
const score = scoreGeometry(join(design, "model.stl"), join(import.meta.dirname, "reference", "model.stl"));
recordScore("case-base", score);

test("the exported STL is a valid, watertight solid", () => {
  expect(score.runs, score.error).toBe(true);
  expect(score.candidate).toMatchObject({ valid: true, watertight: true });
});

test("its shape matches the reference part", () => {
  expect(score.iou).toBeGreaterThanOrEqual(0.95);
  // No surface more than half a millimetre from where the reference has it: a missing or wrong-sized hole or opening fails.
  expect(score.hausdorffMm).toBeLessThanOrEqual(0.5);
});

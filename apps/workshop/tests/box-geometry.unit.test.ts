// The Workshop box evals' geometry scoring: a CAD plan that makes each eval's
// part, exported with Workshop's own geometry, scores as its OpenSCAD reference,
// and a part that is close but wrong does not.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scoreGeometry } from "../../../box/eval/geometry.ts";
import { makeProject } from "../src/lib/project";
import { type CadPlan, CadPlanSchema, planBounds } from "../src/model/cad-plan";

const evals = new URL("../box/evals/evals/", import.meta.url).pathname;
const box = (origin: number[], size: number[], mode: "add" | "cut" = "add") => ({ kind: "box" as const, mode, origin, size });
const cylinder = (base: number[], radius: number, height: number, axis: "x" | "y" | "z", mode: "add" | "cut" = "cut") =>
  ({ kind: "cylinder" as const, mode, base, radius, height, axis });

/** Exports a plan as the box does (export.ts) and scores its STL against an eval's reference. */
function score(name: string, features: unknown[]) {
  const plan = CadPlanSchema.parse({ version: 1, units: "mm", features }) as CadPlan;
  const [width, depth, height] = planBounds(plan).size;
  const base = makeProject("cube");
  const work = mkdtempSync(join(tmpdir(), "workshop-geometry-"));
  writeFileSync(join(work, "project.json"), JSON.stringify({ ...base, name, params: { ...base.params, design: "custom", width, depth, height }, cadPlan: plan }));
  execFileSync(process.execPath, ["--import", "tsx", new URL("../box/export.ts", import.meta.url).pathname, join(work, "project.json"), work], { encoding: "utf8" });
  return scoreGeometry(join(work, "model.stl"), join(evals, name, "reference", "model.stl"));
}

/** What each eval's EVAL.ts requires. */
const passes = (result: ReturnType<typeof score>) =>
  result.runs && result.candidate?.watertight === true && result.iou >= 0.95 && result.hausdorffMm <= 0.5;

const parts: Record<string, unknown[]> = {
  "cable-clip": [box([-30, -20, 0], [60, 40, 20]), cylinder([0, 0, 0], 6, 20, "z")],
  "mounting-plate": [box([0, 0, 0], [80, 60, 5]),
    ...[[8, 8], [72, 8], [8, 52], [72, 52]].map(([x, y]) => cylinder([x, y, 0], 2.5, 5, "z"))],
  // Standing the other way up from the reference, with the upright along y.
  "l-bracket": [box([0, 0, 0], [30, 50, 5]), box([0, 45, 0], [30, 5, 40]), cylinder([15, 20, 0], 3, 5, "z"), cylinder([15, 45, 25], 3, 5, "y")],
  "flanged-bushing": [cylinder([0, 0, 0], 20, 6, "z", "add"), cylinder([0, 0, 6], 10, 14, "z", "add"), cylinder([0, 0, 0], 5, 20, "z")],
};

for (const [name, features] of Object.entries(parts))
  test(`a correct ${name} made with Workshop's geometry passes its eval`, () => {
    const result = score(name, features);
    assert.ok(passes(result), JSON.stringify({ ...result, candidate: undefined, reference: undefined }));
  });

test("a part with a wrong or missing feature fails", () => {
  // The cable clip before its follow-up: a 10 mm hole, not 12.
  assert.equal(passes(score("cable-clip", [box([-30, -20, 0], [60, 40, 20]), cylinder([0, 0, 0], 5, 20, "z")])), false);
  // A plate missing one hole.
  assert.equal(passes(score("mounting-plate", parts["mounting-plate"].slice(0, 4))), false);
  // The base hole on the wrong side of the bracket.
  const bracket = [...parts["l-bracket"]];
  bracket[2] = cylinder([15, 10, 0], 3, 5, "z");
  assert.equal(passes(score("l-bracket", bracket)), false);
});

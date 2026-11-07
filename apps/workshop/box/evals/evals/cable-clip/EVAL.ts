import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// The repository the box left on its default branch.
const design = join(import.meta.dirname, "designs", "cable-clip");
const json = (name: string) => JSON.parse(readFileSync(join(design, name), "utf8"));
const near = (value: number, target: number, tolerance = 1) => Math.abs(value - target) <= tolerance;

test("the design is a 60 x 40 x 20 mm body", () => {
  const [body] = json("bom.json");
  expect(body.kind).toBe("fabricated");
  const [a, b, c] = [body.bounds.width, body.bounds.depth, body.bounds.height].sort((x: number, y: number) => x - y);
  expect(near(a, 20) && near(b, 40) && near(c, 60)).toBe(true);
});

test("a 12 mm hole goes through it", () => {
  const { cadPlan } = json("project.json");
  const holes = cadPlan.features.filter((feature: any) => feature.kind === "cylinder" && feature.mode === "cut");
  expect(holes.some((hole: any) => near(hole.radius * 2, 12, 0.5) && hole.height >= 20 - 0.5)).toBe(true);
  // A 12 mm through hole leaves about 48000 - 2262 mm³.
  const [body] = json("bom.json");
  expect(near(body.volumeMm3, 48000 - Math.PI * 36 * 20, 400)).toBe(true);
});

test("the STEP and STL models were exported", () => {
  expect(readFileSync(join(design, "model.step"), "utf8").startsWith("ISO-10303-21")).toBe(true);
  expect(readFileSync(join(design, "model.stl")).length).toBeGreaterThan(84);
});

import { makeBox, makeCylinder, measureVolume } from "replicad";
import { type Params, ParamsSchema } from "../lib/project";
import { type CadPlan, CadPlanSchema, AssemblyCadPlanSchema, planBounds } from "./cad-plan";

function featureSolid(feature: CadPlan["features"][number]) {
  if (feature.kind === "box")
    return makeBox(feature.origin, [
      feature.origin[0] + feature.size[0],
      feature.origin[1] + feature.size[1],
      feature.origin[2] + feature.size[2],
    ]);
  return makeCylinder(
    feature.radius,
    feature.height,
    feature.base,
    feature.axis === "x" ? [1, 0, 0] : feature.axis === "y" ? [0, 1, 0] : [0, 0, 1],
  );
}

function applyFeature(
  solid: ReturnType<typeof makeBox>,
  part: ReturnType<typeof makeBox>,
  feature: CadPlan["features"][number],
  index: number,
) {
  try {
    const next = feature.mode === "add" ? solid.fuse(part) : solid.cut(part);
    solid.delete();
    return next;
  } catch (error) {
    throw new Error(
      `CAD feature ${index + 1} failed: ${error instanceof Error ? error.message : "the geometry kernel rejected this operation"}`,
    );
  } finally {
    part.delete();
  }
}

/** One solid from a CAD plan alone, as an assembly item stores it. */
export function buildPlannedModel(planInput: CadPlan) {
  const plan = AssemblyCadPlanSchema.parse(planInput);
  let solid: ReturnType<typeof makeBox> | undefined;
  try {
    for (const [index, feature] of plan.features.entries()) {
      const part = featureSolid(feature);
      if (!solid) {
        solid = part;
        continue;
      }
      solid = applyFeature(solid, part, feature, index);
    }
    if (!solid) throw new Error("CAD plan has no solid");
    const volume = measureVolume(solid);
    if (volume <= 0) throw new Error("CAD plan has no positive volume");
    const { size } = planBounds(plan);
    return {
      solid,
      volume,
      checks: [
        `${plan.features.length} bounded CAD feature${plan.features.length === 1 ? "" : "s"}`,
        `${size.join(" × ")} mm added design envelope`,
        "Positive solid volume",
        "Geometry preview; physical fit still requires a test",
      ],
    };
  } catch (error) {
    solid?.delete();
    throw error;
  }
}

function buildCustomModel(plan: CadPlan | undefined, width: number, depth: number, height: number) {
  if (!plan) throw new Error("Custom design has no CAD plan");
  const parsed = CadPlanSchema.parse(plan);
  const { size } = planBounds(parsed);
  if (width !== size[0] || depth !== size[1] || height !== size[2])
    throw new Error("CAD plan and dimensions do not match");
  return buildPlannedModel(parsed);
}

function cubeModel(outer: ReturnType<typeof makeBox>, width: number, depth: number, height: number) {
  if (width !== depth || depth !== height)
    throw new Error("A cube requires equal width, depth, and height");
  const volume = measureVolume(outer);
  if (volume <= 0) throw new Error("Geometry has no positive volume");
  return {
    solid: outer,
    volume,
    checks: [
      "Dimensions within supported range",
      "All three sides are equal",
      "Positive solid volume",
      "Solid cube study",
    ],
  };
}

function buttonFeatures(solid: ReturnType<typeof makeBox>, w: number, d: number, h: number, t: number) {
  // Scaled starting clearances, not dimensions for a particular switch or board.
  solid = solid.cut(makeCylinder(h * 0.2, t + 2, [0, -d / 2 - 1, h * 0.55], [0, 1, 0]));
  return solid.cut(makeBox([-w * 0.1, d / 2 - t - 1, h * 0.55], [w * 0.1, d / 2 + 1, h + 1]));
}

function sensorFeatures(solid: ReturnType<typeof makeBox>, w: number, d: number, h: number, t: number) {
  for (const x of [-w * 0.24, 0, w * 0.24])
    solid = solid.cut(
      makeBox(
        [x - w * 0.055, -d / 2 - 1, h * 0.45],
        [x + w * 0.055, -d / 2 + t + 1, h * 0.8],
      ),
    );
  const radius = Math.min(w - 2 * t, d - 2 * t) * 0.07;
  for (const x of [-w / 2 + t + 2 * radius, w / 2 - t - 2 * radius])
    for (const y of [-d / 2 + t + 2 * radius, d / 2 - t - 2 * radius]) {
      const post = makeCylinder(radius, h * 0.22, [x, y, t]);
      solid = solid
        .fuse(post)
        .cut(makeCylinder(radius * 0.4, h * 0.22 + 1, [x, y, t]));
    }
  return solid;
}

export function buildModel(input: Params, plan?: CadPlan) {
  const p = ParamsSchema.parse(input),
    { width: w, depth: d, height: h, wall: t } = p;
  if (p.design === "custom") return buildCustomModel(plan, w, d, h);
  const outer = makeBox([-w / 2, -d / 2, 0], [w / 2, d / 2, h]);
  if (p.design === "cube") return cubeModel(outer, w, d, h);
  const cavity = makeBox(
    [-w / 2 + t, -d / 2 + t, t],
    [w / 2 - t, d / 2 - t, h + 1],
  );
  let solid = outer.cut(cavity);
  if (p.design === "button") solid = buttonFeatures(solid, w, d, h, t);
  if (p.design === "sensor") solid = sensorFeatures(solid, w, d, h, t);
  const volume = measureVolume(solid);
  if (volume <= 0) throw new Error("Geometry has no positive volume");
  return {
    solid,
    volume,
    checks: [
      "Dimensions within supported range",
      "Wall leaves a positive interior",
      "Positive solid volume",
      p.design === "tray"
        ? "Open tray study"
        : p.design === "button"
          ? "Side button opening and cable notch (scaled assumptions)"
          : "Vent slots and four mounting posts (scaled assumptions)",
    ],
  };
}

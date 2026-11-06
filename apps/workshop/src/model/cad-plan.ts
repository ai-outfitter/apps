import { z } from "zod";
import type { Params } from "../lib/project";

const coordinate = z.number().min(-250).max(250);
const extent = z.number().min(1).max(200);
const radius = z.number().min(0.1).max(200);
const point = z.tuple([coordinate, coordinate, coordinate]);
const mode = z.enum(["add", "cut"]);
const feature = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("box"),
      mode,
      origin: point,
      size: z.tuple([extent, extent, extent]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cylinder"),
      mode,
      base: point,
      radius,
      height: extent,
      axis: z.enum(["x", "y", "z"]),
    })
    .strict(),
]);

export const CadPlanSchema = z
  .object({
    version: z.literal(1),
    units: z.literal("mm"),
    features: z.array(feature).min(1).max(24),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.features[0]?.mode !== "add") {
      ctx.addIssue({ code: "custom", message: "Start with an added solid" });
      return;
    }
    const bounds = planBounds(plan);
    if (bounds.size.some((side) => side > 200))
      ctx.addIssue({ code: "custom", message: "Design exceeds 200 mm" });
  });

export type CadPlan = z.infer<typeof CadPlanSchema>;

function featureBounds(part: CadPlan["features"][number]) {
  const low = [0, 0, 0];
  const high = [0, 0, 0];
  if (part.kind === "box") {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = part.origin[axis];
      high[axis] = part.origin[axis] + part.size[axis];
    }
  } else {
    const axis = { x: 0, y: 1, z: 2 }[part.axis];
    for (let i = 0; i < 3; i++) {
      low[i] = part.base[i] - (i === axis ? 0 : part.radius);
      high[i] = part.base[i] + (i === axis ? part.height : part.radius);
    }
  }
  return { low, high };
}

export function planBounds(plan: Pick<CadPlan, "features">) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of plan.features) {
    if (part.mode !== "add") continue;
    const { low, high } = featureBounds(part);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], low[i]);
      max[i] = Math.max(max[i], high[i]);
    }
  }
  return {
    min: min as [number, number, number],
    max: max as [number, number, number],
    size: max.map((value, i) => Math.round((value - min[i]) * 10) / 10) as [
      number,
      number,
      number,
    ],
  };
}

export function boxPlan(width: number, depth: number, height: number): CadPlan {
  return CadPlanSchema.parse({
    version: 1,
    units: "mm",
    features: [
      {
        kind: "box",
        mode: "add",
        origin: [-width / 2, -depth / 2, 0],
        size: [width, depth, height],
      },
    ],
  });
}

// Mirror the starter shapes so a follow-up sees the solid it is changing.
export function presetPlan(params: Params): CadPlan {
  if (params.design === "custom")
    throw new Error("A custom model requires its saved CAD plan");
  const { width: w, depth: d, height: h, wall: t } = params;
  if (params.design === "cube") return boxPlan(w, d, h);
  const features: CadPlan["features"] = [
    { kind: "box", mode: "add", origin: [-w / 2, -d / 2, 0], size: [w, d, h] },
    {
      kind: "box",
      mode: "cut",
      origin: [-w / 2 + t, -d / 2 + t, t],
      size: [w - 2 * t, d - 2 * t, h + 1 - t],
    },
  ];
  if (params.design === "button") {
    features.push(
      {
        kind: "cylinder",
        mode: "cut",
        base: [0, -d / 2 - 1, h * 0.55],
        radius: h * 0.2,
        height: t + 2,
        axis: "y",
      },
      {
        kind: "box",
        mode: "cut",
        origin: [-w * 0.1, d / 2 - t - 1, h * 0.55],
        size: [w * 0.2, t + 2, h + 1 - h * 0.55],
      },
    );
  }
  if (params.design === "sensor") {
    for (const x of [-w * 0.24, 0, w * 0.24])
      features.push({
        kind: "box",
        mode: "cut",
        origin: [x - w * 0.055, -d / 2 - 1, h * 0.45],
        size: [w * 0.11, t + 2, h * 0.35],
      });
    const r = Math.min(w - 2 * t, d - 2 * t) * 0.07;
    for (const x of [-w / 2 + t + 2 * r, w / 2 - t - 2 * r])
      for (const y of [-d / 2 + t + 2 * r, d / 2 - t - 2 * r])
        features.push(
          {
            kind: "cylinder",
            mode: "add",
            base: [x, y, t],
            radius: r,
            height: h * 0.22,
            axis: "z",
          },
          {
            kind: "cylinder",
            mode: "cut",
            base: [x, y, t],
            radius: r * 0.4,
            height: h * 0.22 + 1,
            axis: "z",
          },
        );
  }
  return CadPlanSchema.parse({ version: 1, units: "mm", features });
}

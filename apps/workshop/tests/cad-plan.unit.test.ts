import test from "node:test";
import assert from "node:assert/strict";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import {
  CadPlanSchema,
  boxPlan,
  presetPlan,
} from "../src/model/cad-plan";
import { buildModel } from "../src/model/geometry";
import { makeProject } from "../src/lib/project";

test("a model plan builds a real cube and a cut mounting plate", async () => {
  setOC(await opencascade());
  const cube = buildModel(
    { design: "custom", width: 40, depth: 40, height: 40, wall: 2.4 },
    boxPlan(40, 40, 40),
  );
  try {
    assert.ok(Math.abs(cube.volume - 64_000) < 0.01);
    assert.ok((await cube.solid.blobSTEP().text()).includes("ISO-10303-21"));
  } finally {
    cube.solid.delete();
  }

  const platePlan = CadPlanSchema.parse({
    version: 1,
    units: "mm",
    features: [
      { kind: "box", mode: "add", origin: [-40, -25, 0], size: [80, 50, 20] },
      {
        kind: "cylinder",
        mode: "cut",
        base: [0, 0, -1],
        radius: 5,
        height: 22,
        axis: "z",
      },
    ],
  });
  const plate = buildModel(
    { design: "custom", width: 80, depth: 50, height: 20, wall: 2.4 },
    platePlan,
  );
  try {
    assert.ok(Math.abs(plate.volume - (80_000 - Math.PI * 5 ** 2 * 20)) < 0.1);
  } finally {
    plate.solid.delete();
  }
});

test("CAD plans reject a cut first and oversize designs", () => {
  assert.equal(
    CadPlanSchema.safeParse({
      version: 1,
      units: "mm",
      features: [
        { kind: "box", mode: "cut", origin: [0, 0, 0], size: [40, 40, 40] },
      ],
    }).success,
    false,
  );
  assert.equal(
    CadPlanSchema.safeParse({
      version: 1,
      units: "mm",
      features: [
        { kind: "box", mode: "add", origin: [-150, 0, 0], size: [300, 40, 40] },
        { kind: "box", mode: "add", origin: [150, 0, 0], size: [20, 40, 40] },
      ],
    }).success,
    false,
  );
});

test("starter enclosure plans preserve their existing geometry for follow-ups", async () => {
  setOC(await opencascade());
  for (const example of ["holder", "button", "sensor"]) {
    const params = makeProject(example).params;
    const planned = presetPlan(params);
    const original = buildModel(params);
    const converted = buildModel({ ...params, design: "custom" }, planned);
    try {
      assert.ok(planned.features.length > 1);
      assert.ok(
        Math.abs(original.volume - converted.volume) < 0.01,
        `${example} volume changed during plan conversion`,
      );
    } finally {
      original.solid.delete();
      converted.solid.delete();
    }
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { Matrix4, Vector3 } from "three";
import { hingeTransforms, type Hinge } from "../src/lib/inspection-placements";
import { JointSchema } from "../src/lib/operation-schema";

test("a moving enclosure's inspection door opens around its installed hinge at the current operation pose", () => {
  const rest = new Matrix4().makeTranslation(10, 0, 0);
  const door: Hinge = {
    path: "case/door",
    rest,
    joint: { kind: "revolute", axis: [0, 0, 1], pivot: [1, 0, 0], openDegrees: 90 },
  };
  const carried = new Matrix4().makeRotationZ(Math.PI / 2).multiply(rest);
  const pose = new Map([[door.path, carried]]);
  const point = new Vector3(3, 0, 0).applyMatrix4(carried);
  const opened = point.clone().applyMatrix4(hingeTransforms([door], pose)[0].delta);
  assert.ok(opened.distanceTo(new Vector3(-2, 11, 0)) < 1e-6);
  assert.deepEqual(hingeTransforms([], pose), []);
  assert.ok(point.distanceTo(new Vector3(0, 13, 0)) < 1e-6);
  assert.ok(JointSchema.safeParse({ ...door.joint, openDegrees: -95 }).success);
  for (const invalid of [{ kind: "prismatic" }, { openDegrees: 0 }, { openDegrees: 361 }]) {
    assert.equal(JointSchema.safeParse({ ...door.joint, ...invalid }).success, false);
  }
});

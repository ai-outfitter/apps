import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { axisRotations, centred, checkMesh, parseStl, readStl, rotated, scoreGeometry, scoreMeshes, type Mesh } from "../eval/geometry.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const clip = here("../../apps/workshop/box/evals/evals/cable-clip/reference/model.stl");
const hasOpenscad = spawnSync(process.env.OPENSCAD || "openscad", ["--version"]).status === 0;

/** An axis-aligned box from (0,0,0) to size, wound outward. */
function box([x, y, z]: [number, number, number]): Mesh {
  const v = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { triangles: Float64Array.from(faces.flatMap((face) => face.flatMap((i) => v[i]))) };
}

test("a closed box is a valid, watertight solid", () => {
  const check = checkMesh(box([60, 40, 20]));
  assert.equal(check.watertight, true);
  assert.ok(Math.abs(check.volumeMm3 - 48000) < 1e-6);
});

test("a hole or a flipped face is not watertight", () => {
  const open = { triangles: box([10, 10, 10]).triangles.slice(9) };
  assert.equal(checkMesh(open).watertight, false);
  assert.ok(checkMesh(open).boundaryEdges > 0);
  const flipped = box([10, 10, 10]).triangles;
  flipped.set([...flipped.subarray(6, 9), ...flipped.subarray(3, 6)], 3);
  const check = checkMesh({ triangles: flipped });
  assert.equal(check.watertight, false);
  assert.ok(check.misorientedEdges > 0);
});

test("binary and ASCII STL read the same triangles", () => {
  const mesh = box([1, 2, 3]);
  const binary = Buffer.alloc(84 + 12 * 50);
  binary.writeUInt32LE(12, 80);
  mesh.triangles.forEach((value, i) => binary.writeFloatLE(value, 84 + Math.floor(i / 9) * 50 + 12 + (i % 9) * 4));
  const ascii = `solid box\n${Array.from({ length: 12 }, (_, f) => `facet normal 0 0 0\nouter loop\n${[0, 1, 2].map((k) =>
    `vertex ${[...mesh.triangles.subarray(f * 9 + k * 3, f * 9 + k * 3 + 3)].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid box\n`;
  assert.deepEqual([...parseStl(binary).triangles], [...mesh.triangles]);
  assert.deepEqual([...parseStl(Buffer.from(ascii)).triangles], [...mesh.triangles]);
});

test("a part scores as itself whatever its position and orientation", () => {
  const reference = readStl(clip);
  const moved = rotated(centred(reference), axisRotations[7]);
  moved.triangles.forEach((_, i) => (moved.triangles[i] += [100, -20, 5][i % 3]));
  const score = scoreMeshes(moved, reference);
  assert.equal(score.watertight, true);
  assert.ok(score.iou > 0.999, `IoU ${score.iou}`);
  assert.ok(score.chamferMm < 0.05, `Chamfer ${score.chamferMm}`);
});

test("a different part scores worse", () => {
  const reference = readStl(clip);
  const solid = scoreMeshes(box([60, 40, 20]), reference);
  assert.ok(solid.iou < 0.97 && solid.iou > 0.9, `IoU ${solid.iou}`);
  const small = scoreMeshes(box([40, 30, 20]), reference);
  assert.ok(small.iou < 0.6, `IoU ${small.iou}`);
  assert.ok(small.chamferMm > 3, `Chamfer ${small.chamferMm}`);
});

test("OpenSCAD code is rendered and scored, and code that fails does not run", { skip: !hasOpenscad && "no openscad" }, () => {
  const earlier = scoreGeometry(here("fixtures/clip-10mm.scad"), clip);
  assert.equal(earlier.runs, true);
  assert.equal(earlier.watertight, true);
  assert.ok(earlier.iou > 0.9 && earlier.iou < 0.99, `IoU ${earlier.iou}`);
  const broken = scoreGeometry(here("fixtures/broken.scad"), clip);
  assert.equal(broken.runs, false);
  assert.equal(broken.iou, 0);
});

// Geometry scoring for CAD evals, as text-to-CAD benchmarks score a model's
// output against a reference part (CADPrompt, Text2CAD, CAD-Recode):
//
// - runs: the candidate's OpenSCAD code renders (or its STL exists);
// - valid and watertight: the mesh is a closed, consistently wound, manifold
//   solid with positive volume;
// - Chamfer and Hausdorff distance between points sampled on both surfaces;
// - volume IoU of the two solids.
//
// Prompts give sizes in millimetres, so shapes keep their scale. Both are
// centred on their bounding boxes and the candidate is tried in each of the
// 24 axis-aligned orientations (a design may stand on another face); the one
// with the best IoU is scored. chamferMm and hausdorffMm are in millimetres;
// chamferUnit is the DeepCAD/Text2CAD/CAD-Recode convention (both shapes
// scaled so the reference fits a unit box, squared distances, x 10^3).
//
// No dependencies: STL parsing, sampling and voxelising are done here.
// OpenSCAD itself (`openscad`, or OPENSCAD=<path>) is needed only to render .scad files.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Vec3 = [number, number, number];
/** Triangles as flat coordinates: 9 numbers per triangle. */
export type Mesh = { triangles: Float64Array };

/** Reads binary or ASCII STL. */
export function parseStl(data: Buffer | Uint8Array): Mesh {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const count = buffer.length >= 84 ? buffer.readUInt32LE(80) : -1;
  if (count >= 0 && 84 + count * 50 === buffer.length) {
    const triangles = new Float64Array(count * 9);
    for (let t = 0; t < count; t++) {
      const offset = 84 + t * 50 + 12;
      for (let i = 0; i < 9; i++) triangles[t * 9 + i] = buffer.readFloatLE(offset + i * 4);
    }
    return { triangles };
  }
  const text = buffer.toString("utf8");
  if (!/^\s*solid/.test(text)) throw new Error("Not an STL file");
  const numbers = [...text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap((match) => match.slice(1, 4).map(Number));
  if (numbers.length % 9 !== 0 || numbers.some((value) => !Number.isFinite(value))) throw new Error("Malformed ASCII STL");
  return { triangles: Float64Array.from(numbers) };
}

export function readStl(file: string) {
  return parseStl(readFileSync(file));
}

/** Renders OpenSCAD code to an STL mesh. `ok` is the "code runs" check. */
export function renderScad(file: string, binary = process.env.OPENSCAD || "openscad") {
  const work = mkdtempSync(join(tmpdir(), "scad-"));
  try {
    const out = join(work, "model.stl");
    const run = spawnSync(binary, ["-o", out, file], { encoding: "utf8", timeout: 300_000 });
    if (run.error) return { ok: false as const, error: `Could not run ${binary}: ${run.error.message}` };
    if (run.status !== 0) return { ok: false as const, error: (run.stderr || `openscad exited ${run.status}`).trim().slice(-2000) };
    try {
      return { ok: true as const, mesh: readStl(out), log: run.stderr };
    } catch (error) {
      return { ok: false as const, error: `OpenSCAD wrote no usable STL: ${(error as Error).message}` };
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** An .stl or .scad file as a mesh, or why it did not produce one. */
export function loadGeometry(file: string): { ok: true; mesh: Mesh } | { ok: false; error: string } {
  if (file.endsWith(".scad")) return renderScad(file);
  try {
    return { ok: true, mesh: readStl(file) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export function bounds(mesh: Mesh) {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], t[i + axis]);
      max[axis] = Math.max(max[axis], t[i + axis]);
    }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as Vec3 };
}

/** Signed volume from the divergence theorem; positive for outward-facing triangles. */
export function volume(mesh: Mesh) {
  const t = mesh.triangles;
  let sum = 0;
  for (let i = 0; i < t.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t.subarray(i, i + 9);
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return sum / 6;
}

export type MeshCheck = {
  triangles: number;
  degenerateTriangles: number;
  /** Edges used by one triangle: holes in the surface. */
  boundaryEdges: number;
  /** Edges shared by more than two triangles. */
  nonManifoldEdges: number;
  /** Edges whose two triangles run the same way: flipped faces. */
  misorientedEdges: number;
  volumeMm3: number;
  size: Vec3;
  /** Has triangles, finite coordinates and positive volume. */
  valid: boolean;
  /** Closed, manifold and consistently wound. */
  watertight: boolean;
};

/** Mesh validity: welds vertices (to `tolerance` mm) and counts how each edge is used. */
export function checkMesh(mesh: Mesh, tolerance = 1e-4): MeshCheck {
  const t = mesh.triangles;
  const ids = new Map<string, number>();
  const vertex = (i: number) => {
    const key = `${Math.round(t[i] / tolerance)},${Math.round(t[i + 1] / tolerance)},${Math.round(t[i + 2] / tolerance)}`;
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = ids.size));
    return id;
  };
  // Directed edge use: a closed, consistently wound surface uses a -> b once and b -> a once.
  const directed = new Map<string, number>();
  let degenerate = 0;
  for (let i = 0; i < t.length; i += 9) {
    const [a, b, c] = [vertex(i), vertex(i + 3), vertex(i + 6)];
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    for (const [p, q] of [[a, b], [b, c], [c, a]]) directed.set(`${p}>${q}`, (directed.get(`${p}>${q}`) ?? 0) + 1);
  }
  let boundary = 0;
  let nonManifold = 0;
  let misoriented = 0;
  const seen = new Set<string>();
  for (const [key, forward] of directed) {
    const [p, q] = key.split(">");
    const pair = p < q ? `${p}|${q}` : `${q}|${p}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const backward = directed.get(`${q}>${p}`) ?? 0;
    const total = forward + backward;
    if (total === 1) boundary++;
    else if (total > 2) nonManifold++;
    else if (forward !== backward) misoriented++;
  }
  const triangles = t.length / 9;
  const volumeMm3 = volume(mesh);
  const { size } = bounds(mesh);
  const finite = t.every(Number.isFinite);
  const valid = triangles > 0 && finite && volumeMm3 > 0;
  return { triangles, degenerateTriangles: degenerate, boundaryEdges: boundary, nonManifoldEdges: nonManifold,
    misorientedEdges: misoriented, volumeMm3, size, valid, watertight: valid && boundary === 0 && nonManifold === 0 && misoriented === 0 };
}

/** A small deterministic generator, so scores repeat run to run. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/** `count` points spread over the surface by area (flat xyz). */
export function samplePoints(mesh: Mesh, count: number, seed = 1) {
  const t = mesh.triangles;
  const areas = new Float64Array(t.length / 9);
  let total = 0;
  for (let i = 0, f = 0; i < t.length; i += 9, f++) {
    const u = [t[i + 3] - t[i], t[i + 4] - t[i + 1], t[i + 5] - t[i + 2]];
    const v = [t[i + 6] - t[i], t[i + 7] - t[i + 1], t[i + 8] - t[i + 2]];
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    total += Math.hypot(cross[0], cross[1], cross[2]) / 2;
    areas[f] = total;
  }
  const next = random(seed);
  const points = new Float64Array(count * 3);
  for (let n = 0; n < count; n++) {
    const target = next() * total;
    let low = 0;
    let high = areas.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (areas[middle] < target) low = middle + 1;
      else high = middle;
    }
    const i = low * 9;
    let r1 = next();
    let r2 = next();
    if (r1 + r2 > 1) [r1, r2] = [1 - r1, 1 - r2];
    for (let axis = 0; axis < 3; axis++)
      points[n * 3 + axis] = t[i + axis] + r1 * (t[i + 3 + axis] - t[i + axis]) + r2 * (t[i + 6 + axis] - t[i + axis]);
  }
  return points;
}

/** Nearest-neighbour distances from each point of `from` to the points of `to`, through a uniform grid. */
export function nearestDistances(from: Float64Array, to: Float64Array) {
  const count = to.length / 3;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < to.length; i += 3)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], to[i + axis]);
      max[axis] = Math.max(max[axis], to[i + axis]);
    }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-9);
  const cell = extent / Math.max(1, Math.round(Math.cbrt(count) * 1.5));
  const cells = new Map<string, number[]>();
  const index = (value: number, axis: number) => Math.floor((value - min[axis]) / cell);
  for (let p = 0; p < count; p++) {
    const key = `${index(to[p * 3], 0)},${index(to[p * 3 + 1], 1)},${index(to[p * 3 + 2], 2)}`;
    const list = cells.get(key);
    if (list) list.push(p);
    else cells.set(key, [p]);
  }
  const span = Math.ceil(extent / cell) + 2;
  const distances = new Float64Array(from.length / 3);
  for (let q = 0; q < distances.length; q++) {
    const [x, y, z] = [from[q * 3], from[q * 3 + 1], from[q * 3 + 2]];
    const [cx, cy, cz] = [index(x, 0), index(y, 1), index(z, 2)];
    let best = Infinity;
    // Grow the searched shell until no unsearched cell can hold a closer point.
    for (let ring = 0; ring <= span + Math.ceil(Math.hypot(x - min[0], y - min[1], z - min[2]) / cell); ring++) {
      for (let i = -ring; i <= ring; i++)
        for (let j = -ring; j <= ring; j++)
          for (let k = -ring; k <= ring; k++) {
            if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== ring) continue;
            const list = cells.get(`${cx + i},${cy + j},${cz + k}`);
            if (!list) continue;
            for (const p of list) {
              const d = (to[p * 3] - x) ** 2 + (to[p * 3 + 1] - y) ** 2 + (to[p * 3 + 2] - z) ** 2;
              if (d < best) best = d;
            }
          }
      if (best <= (ring * cell) ** 2) break;
    }
    distances[q] = Math.sqrt(best);
  }
  return distances;
}

/** Squared distance from point (px,py,pz) to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangle(px: number, py: number, pz: number, t: Float64Array, f: number) {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = [t[f], t[f + 1], t[f + 2], t[f + 3], t[f + 4], t[f + 5], t[f + 6], t[f + 7], t[f + 8]];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const at = (x: number, y: number, z: number) => (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
  if (d1 <= 0 && d2 <= 0) return at(ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return at(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return at(ax + v * abx, ay + v * aby, az + v * abz);
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return at(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return at(ax + w * acx, ay + w * acy, az + w * acz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz));
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator, w = vc * denominator;
  return at(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/** Distance from each point (flat xyz) to the nearest triangle of a mesh. */
export function surfaceDistances(points: Float64Array, mesh: Mesh) {
  const t = mesh.triangles;
  const distances = new Float64Array(points.length / 3);
  for (let q = 0; q < distances.length; q++) {
    const [x, y, z] = [points[q * 3], points[q * 3 + 1], points[q * 3 + 2]];
    let best = Infinity;
    for (let f = 0; f < t.length; f += 9) {
      // Skip triangles whose bounding box is already farther than the best.
      const dx = Math.max(Math.min(t[f], t[f + 3], t[f + 6]) - x, x - Math.max(t[f], t[f + 3], t[f + 6]), 0);
      const dy = Math.max(Math.min(t[f + 1], t[f + 4], t[f + 7]) - y, y - Math.max(t[f + 1], t[f + 4], t[f + 7]), 0);
      const dz = Math.max(Math.min(t[f + 2], t[f + 5], t[f + 8]) - z, z - Math.max(t[f + 2], t[f + 5], t[f + 8]), 0);
      if (dx * dx + dy * dy + dz * dz >= best) continue;
      const d = pointTriangle(x, y, z, t, f);
      if (d < best) best = d;
    }
    distances[q] = Math.sqrt(best);
  }
  return distances;
}

/** The 24 rotations that map the axes onto the axes, as signed axis permutations. */
export const axisRotations: { axes: Vec3; signs: Vec3 }[] = (() => {
  const permutations: Vec3[] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const parity = (p: Vec3) => (p[0] > p[1] ? 1 : 0) + (p[0] > p[2] ? 1 : 0) + (p[1] > p[2] ? 1 : 0);
  const rotations: { axes: Vec3; signs: Vec3 }[] = [];
  for (const axes of permutations)
    for (let mask = 0; mask < 8; mask++) {
      const signs = [mask & 1 ? -1 : 1, mask & 2 ? -1 : 1, mask & 4 ? -1 : 1] as Vec3;
      // Determinant +1: no mirror images.
      if ((parity(axes) % 2 === 0 ? 1 : -1) * signs[0] * signs[1] * signs[2] === 1) rotations.push({ axes, signs });
    }
  return rotations;
})();

/** The mesh moved so its bounding box is centred on the origin. */
export function centred(mesh: Mesh): Mesh {
  const { min, max } = bounds(mesh);
  const centre = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return { triangles: mesh.triangles.map((value, i) => value - centre[i % 3]) };
}

/** New coordinate `axis` is `signs[axis] * old[axes[axis]]`. */
export function rotated(mesh: Mesh, rotation: { axes: Vec3; signs: Vec3 }): Mesh {
  const t = mesh.triangles;
  const out = new Float64Array(t.length);
  for (let i = 0; i < t.length; i += 3)
    for (let axis = 0; axis < 3; axis++) out[i + axis] = rotation.signs[axis] * t[i + rotation.axes[axis]];
  // A rotation keeps the winding outward.
  return { triangles: out };
}

/** Which cells of an n^3 grid over [-half, half]^3 lie inside the mesh, by ray parity along z. */
export function voxelize(mesh: Mesh, half: number, n: number) {
  const cell = (2 * half) / n;
  const inside = new Uint8Array(n * n * n);
  const crossings: number[][] = Array.from({ length: n * n }, () => []);
  // A slight offset keeps the rays off the edges of axis-aligned faces.
  const jitter = cell * 1e-3 * Math.SQRT2;
  const centre = (i: number) => -half + (i + 0.5) * cell + jitter;
  const t = mesh.triangles;
  for (let f = 0; f < t.length; f += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t.subarray(f, f + 9);
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(denominator) < 1e-12) continue;
    const low = (value: number) => Math.max(0, Math.ceil((value + half - jitter) / cell - 0.5));
    const high = (value: number) => Math.min(n - 1, Math.floor((value + half - jitter) / cell - 0.5));
    for (let i = low(Math.min(ax, bx, cx)); i <= high(Math.max(ax, bx, cx)); i++)
      for (let j = low(Math.min(ay, by, cy)); j <= high(Math.max(ay, by, cy)); j++) {
        const [x, y] = [centre(i), centre(j)];
        const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
        const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
        const w = 1 - u - v;
        if (u < 0 || v < 0 || w < 0) continue;
        crossings[i * n + j].push(u * az + v * bz + w * cz);
      }
  }
  for (let column = 0; column < n * n; column++) {
    const hits = crossings[column].sort((a, b) => a - b);
    for (let h = 0; h + 1 < hits.length; h += 2) {
      for (let k = 0; k < n; k++) {
        const z = centre(k);
        if (z > hits[h] && z < hits[h + 1]) inside[column * n + k] = 1;
      }
    }
  }
  return inside;
}

export function voxelIou(a: Uint8Array, b: Uint8Array) {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    intersection += a[i] & b[i];
    union += a[i] | b[i];
  }
  return union ? intersection / union : 0;
}

export type GeometryScore = {
  /** The code rendered (or the STL was read). */
  runs: boolean;
  error?: string;
  candidate?: MeshCheck;
  reference?: MeshCheck;
  valid: boolean;
  watertight: boolean;
  /** Volume IoU, 0..1. */
  iou: number;
  /** Mean distance from each surface to the other, in mm: points sampled on one
   * surface measured to the other's triangles, both ways, averaged. Exact, so a
   * part scored against itself gives 0 (point-to-point Chamfer has sampling noise). */
  chamferMm: number;
  /** The largest of those distances, in mm. */
  hausdorffMm: number;
  /** Point-to-point Chamfer, 8192 points a side, squared distances on the reference's unit box, x 10^3 (DeepCAD/CAD-Recode convention). */
  chamferUnit: number;
  /** The candidate's best orientation, as a signed axis permutation. */
  rotation?: { axes: Vec3; signs: Vec3 };
};

export type ScoreOptions = { points?: number; voxels?: number };

const failed = (error: string, reference?: MeshCheck): GeometryScore => ({
  // CADPrompt scores code that does not run as IoU 0 and the largest unit-cube distance.
  runs: false, error, reference, valid: false, watertight: false, iou: 0, chamferMm: Infinity, hausdorffMm: Infinity, chamferUnit: 3000,
});

/** Scores a candidate mesh against a reference mesh. */
export function scoreMeshes(candidateMesh: Mesh, referenceMesh: Mesh, options: ScoreOptions = {}): GeometryScore {
  const points = options.points ?? 4096;
  const n = options.voxels ?? 64;
  const reference = checkMesh(referenceMesh);
  const candidate = checkMesh(candidateMesh);
  if (!reference.valid) throw new Error("The reference mesh is not a valid solid");
  const base = { runs: true, candidate, reference, valid: candidate.valid, watertight: candidate.watertight };
  if (!candidate.valid) return { ...base, iou: 0, chamferMm: Infinity, hausdorffMm: Infinity, chamferUnit: 3000 };
  const ref = centred(referenceMesh);
  const cand = centred(candidateMesh);
  const half = (Math.max(...reference.size, ...candidate.size) / 2) * 1.02;
  const referenceVoxels = voxelize(ref, half, n);
  // Voxelise the candidate once per orientation; a cube grid centred on the origin suits all 24.
  let best = { iou: -1, rotation: axisRotations[0] };
  for (const rotation of axisRotations) {
    const iou = voxelIou(voxelize(rotated(cand, rotation), half, n), referenceVoxels);
    if (iou > best.iou) best = { iou, rotation };
  }
  const aligned = rotated(cand, best.rotation);
  const mean = (values: Float64Array) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanSquare = (values: Float64Array) => values.reduce((sum, value) => sum + value * value, 0) / values.length;
  const toReference = surfaceDistances(samplePoints(aligned, points, 1), ref);
  const toCandidate = surfaceDistances(samplePoints(ref, points, 2), aligned);
  const p = samplePoints(aligned, 8192, 3);
  const q = samplePoints(ref, 8192, 4);
  const scale = Math.max(...reference.size);
  return {
    ...base,
    iou: best.iou,
    chamferMm: (mean(toReference) + mean(toCandidate)) / 2,
    hausdorffMm: Math.max(toReference.reduce((a, b) => Math.max(a, b), 0), toCandidate.reduce((a, b) => Math.max(a, b), 0)),
    chamferUnit: ((meanSquare(nearestDistances(p, q)) + meanSquare(nearestDistances(q, p))) / scale ** 2) * 1000,
    rotation: best.rotation,
  };
}

/** Scores a candidate .stl or .scad file against a reference .stl or .scad file. */
export function scoreGeometry(candidateFile: string, referenceFile: string, options: ScoreOptions = {}): GeometryScore {
  const reference = loadGeometry(referenceFile);
  if (!reference.ok) throw new Error(`Reference ${referenceFile}: ${reference.error}`);
  const candidate = loadGeometry(candidateFile);
  if (!candidate.ok) return failed(candidate.error, checkMesh(reference.mesh));
  return scoreMeshes(candidate.mesh, reference.mesh, options);
}

/** A score rounded for tables and JSON. */
export function summary(score: GeometryScore) {
  const round = (value: number, places: number) => (Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : null);
  return { runs: score.runs, valid: score.valid, watertight: score.watertight, iou: round(score.iou, 4),
    chamferMm: round(score.chamferMm, 3), hausdorffMm: round(score.hausdorffMm, 3), chamferUnit: round(score.chamferUnit, 4),
    ...(score.error ? { error: score.error } : {}) };
}

/** Keeps a fixture's score for the eval's metrics: grading sets BOX_EVAL_SCORES to a JSON file. */
export function recordScore(name: string, score: GeometryScore) {
  const file = process.env.BOX_EVAL_SCORES;
  if (!file) return;
  const scores = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  scores[name] = summary(score);
  writeFileSync(file, `${JSON.stringify(scores, null, 2)}\n`);
}

// Scores CAD output against a reference part, outside a box run:
//
//   node --import tsx box/eval/score.ts <candidate.stl|.scad> <reference.stl|.scad>
//   node --import tsx box/eval/score.ts render <reference.scad> [...]
//
// The first prints the score as JSON (box/eval/geometry.ts). `render` writes
// each reference.scad's STL beside it, as the eval fixtures keep them, so
// grading needs no OpenSCAD. Set OPENSCAD to use another binary.
import { spawnSync } from "node:child_process";
import { checkMesh, readStl, scoreGeometry, summary } from "./geometry.ts";

const [first, ...rest] = process.argv.slice(2);
if (first === "render") {
  for (const scad of rest) {
    const stl = scad.replace(/\.scad$/, ".stl");
    const run = spawnSync(process.env.OPENSCAD || "openscad", ["-o", stl, scad], { stdio: "inherit" });
    if (run.status !== 0) throw new Error(`OpenSCAD failed on ${scad}`);
    const check = checkMesh(readStl(stl));
    if (!check.watertight) throw new Error(`${stl} is not watertight: ${JSON.stringify(check)}`);
    console.log(`${stl}: ${check.triangles} triangles, ${check.volumeMm3.toFixed(1)} mm³, ${check.size.map((side) => side.toFixed(2)).join(" x ")} mm`);
  }
} else if (first && rest[0]) {
  console.log(JSON.stringify(summary(scoreGeometry(first, rest[0])), null, 2));
} else {
  throw new Error("Usage: score.ts <candidate> <reference> | score.ts render <reference.scad> [...]");
}

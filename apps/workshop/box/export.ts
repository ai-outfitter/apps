// Builds a Workshop project's model with the app's own geometry and writes
// its STEP and STL files. The Workshop box driver runs it once per design:
//   node --import tsx export.ts <project.json> <output directory>
// Its last output line is JSON: the model's bounds, volume and feature count,
// and the assembly's BOM lines (OpenCascade logs to stdout before it).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setOC } from "replicad";
import opencascade from "replicad-opencascadejs";
import { bomTotals } from "../src/lib/assembly";
import { ProjectSchema } from "../src/lib/project";
import { planBounds, presetPlan } from "../src/model/cad-plan";
import { buildModel } from "../src/model/geometry";

const [projectFile, output] = process.argv.slice(2);
if (!projectFile || !output) throw new Error("Usage: export.ts <project.json> <output directory>");
setOC(await opencascade());
const project = ProjectSchema.parse(JSON.parse(readFileSync(projectFile, "utf8")));
const plan = project.cadPlan ?? presetPlan(project.params);
const model = buildModel(project.params, project.cadPlan);
try {
  writeFileSync(join(output, "model.step"), Buffer.from(await model.solid.blobSTEP().arrayBuffer()));
  writeFileSync(join(output, "model.stl"), Buffer.from(await model.solid.blobSTL({ binary: true }).arrayBuffer()));
  const [width, depth, height] = planBounds(plan).size;
  // Assembly items other than firmware, with their quantity per top assembly.
  const parts = bomTotals(project.assembly).lines
    .filter(({ item }) => item.kind !== "firmware" && item.kind !== "assembly")
    .map(({ item, quantity }) => ({ part: item.name, quantity, kind: item.kind === "cots" ? "purchased" : "fabricated" }));
  console.log(`\n${JSON.stringify({ bounds: { width, depth, height }, volumeMm3: Math.round(model.volume * 10) / 10, features: plan.features.length, parts })}`);
} finally {
  model.solid.delete();
}

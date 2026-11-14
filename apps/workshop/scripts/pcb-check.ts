// Runs KiCad ERC and DRC for a project once its breadboard evidence is current,
// writing the reports and the command record to a folder.
import { resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  ProjectSchema,
  pcbReady,
} from "../src/lib/project";
const [projectFile, schematic, board, out = "exports/pcb-checks"] =
  process.argv.slice(2);
if (!projectFile || !schematic || !board)
  throw new Error(
    "Usage: npm run pcb-check --workspace apps/workshop -- project.json design.kicad_sch design.kicad_pcb [report-dir]",
  );
const project = ProjectSchema.parse(
  JSON.parse(await readFile(projectFile, "utf8")),
);
console.log(
  `Checking project revision ${project.revision}, updated ${project.updatedAt}. Re-export after any newer bench result.`,
);
if (!pcbReady(project))
  throw new Error(
    "Record a passing breadboard test for the current hardware and firmware baseline before PCB checks.",
  );
await mkdir(out, { recursive: true });
for (const [kind, check, input] of [
  ["sch", "erc", schematic],
  ["pcb", "drc", board],
]) {
  const output = resolve(out, `${check}.json`);
  const result = spawnSync(
    "kicad-cli",
    [
      kind,
      check,
      "--exit-code-violations",
      "--format",
      "json",
      "--output",
      output,
      resolve(input),
    ],
    { encoding: "utf8" },
  );
  await writeFile(
    resolve(out, `${check}-run.json`),
    JSON.stringify(
      {
        command: "kicad-cli",
        input: resolve(input),
        output,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
      },
      null,
      2,
    ),
  );
  if ((result.error as NodeJS.ErrnoException)?.code === "ENOENT")
    throw new Error(
      "kicad-cli not found. Install KiCad before running PCB checks.",
    );
  if (result.error || result.status !== 0)
    throw new Error(`${check.toUpperCase()} did not pass. Inspect ${out}.`);
}
console.log(
  "ERC and DRC passed. Independent review and physical bring-up are still required.",
);

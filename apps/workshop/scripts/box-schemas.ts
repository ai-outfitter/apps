// Writes the Workshop box's JSON Schemas to box/schemas from src/box/contract.ts.
// `--check` fails instead when a committed file is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { boxJsonSchema, boxSchemas } from "../src/box/contract";

const directory = resolve(import.meta.dirname, "../box/schemas");
const check = process.argv.includes("--check");
const stale = [];
for (const name of Object.keys(boxSchemas) as (keyof typeof boxSchemas)[]) {
  const file = resolve(directory, `${name}.schema.json`);
  const text = `${JSON.stringify(boxJsonSchema(name), null, 2)}\n`;
  let current = "";
  try { current = readFileSync(file, "utf8"); } catch {}
  if (current === text) continue;
  if (check) stale.push(file);
  else writeFileSync(file, text);
}
if (stale.length) {
  console.error(`Stale box schemas; run node --import tsx scripts/box-schemas.ts:\n${stale.join("\n")}`);
  process.exit(1);
}

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadFixture } from "./engine";
import { readWorkflowPackage } from "./source";

const command = process.argv[2];
if (!["check", "build"].includes(command)) throw new Error("Usage: outfitter-workflow <check|build>");
const root = process.cwd();
const artifact = readWorkflowPackage(root);
const definition = artifact.definition;
let fixtures = 0;
const directory = join(root, "fixtures");
for (const file of existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".yaml")) : []) {
  loadFixture(parse(readFileSync(join(directory, file), "utf8")), definition);
  fixtures++;
}
if (command === "build") {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist/workflow.json"), `${JSON.stringify(artifact, null, 2)}\n`);
}
console.log(`${artifact.package}: ${definition.id}, ${fixtures} fixtures verified`);

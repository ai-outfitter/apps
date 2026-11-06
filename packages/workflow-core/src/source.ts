import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkflowPackage } from "./artifact";
import { readWorkflowFile } from "./files";

export function readWorkflowPackage(root: string): WorkflowPackage {
  root = realpathSync(resolve(root));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.outfitter?.kind !== "workflow") throw new Error("Not a workflow package");
  const path = realpathSync(resolve(root, manifest.outfitter.definition));
  if (!path.startsWith(`${root}/`)) throw new Error("Workflow source escapes its package");
  return WorkflowPackage.parse({ package: manifest.name, version: manifest.version, definition: readWorkflowFile(path, undefined, root) });
}

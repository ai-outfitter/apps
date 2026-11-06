import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { parse } from "yaml";
import { inlineSchemaFiles } from "./schema";

/** Package-local schema files, or public exports of a declared dependency. */
function schemaPath(directory: string, file: string, packageRoot: string) {
  if (file.startsWith("@")) {
    if (file.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error("Invalid workflow dependency reference");
    const dependency = file.split("/").slice(0, 2).join("/");
    const manifestPath = resolve(packageRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!Object.hasOwn(manifest.dependencies ?? {}, dependency)) throw new Error("Undeclared workflow schema dependency");
    return createRequire(manifestPath).resolve(file);
  }
  const path = realpathSync(resolve(directory, file));
  if (!path.startsWith(`${realpathSync(packageRoot)}${sep}`)) throw new Error("Workflow schema escapes its package");
  return path;
}

/** Read a workflow package into its portable stored form, inlining only schemas
 * it owns or explicitly imports through another package's public contract. */
export function readWorkflowFile(path: string, definition: unknown = parse(readFileSync(path, "utf8")), packageRoot = dirname(resolve(path))) {
  const directory = dirname(resolve(path));
  return inlineSchemaFiles(definition, (file) => parse(readFileSync(schemaPath(directory, file, packageRoot), "utf8")));
}

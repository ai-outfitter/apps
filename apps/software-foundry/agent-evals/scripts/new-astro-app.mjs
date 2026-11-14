// Fills the new-astro-app fixture with what a caller repository of the public
// SDK carries: this checkout's packages/* and apps/hr (the Astro reference
// app), then writes its lockfile. They are generated, not committed (.gitignore).
//
//   node apps/software-foundry/agent-evals/scripts/new-astro-app.mjs
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";

const repository = join(import.meta.dirname, "../../../../..");
const fixture = join(import.meta.dirname, "../evals/new-astro-app");
const skip = new Set(["node_modules", "dist", ".astro", ".outfitter", "test-results"]);
const filter = (source) => !skip.has(source.split("/").at(-1));

for (const path of ["packages", "apps", "package-lock.json", "node_modules"]) rmSync(join(fixture, path), { recursive: true, force: true });
cpSync(join(repository, "packages"), join(fixture, "packages"), { recursive: true, filter });
cpSync(join(repository, "apps/hr"), join(fixture, "apps/hr"), { recursive: true, filter });
execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], { cwd: fixture, stdio: "inherit" });
console.log(`Prepared ${fixture}`);

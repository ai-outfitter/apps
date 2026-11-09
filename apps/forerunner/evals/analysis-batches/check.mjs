import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const fixture = fileURLToPath(new URL("./evals/oversized-gmail/", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "forerunner-batch-eval-"));
try {
  cpSync(fixture, directory, { recursive: true });
  if (!process.argv.includes("--baseline")) cpSync(new URL("../../src/server/analysis-batches.ts", import.meta.url), join(directory, "src/analysis-batches.ts"));
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  writeFileSync(join(directory, "vitest.config.mjs"), 'export default { test: { include: ["EVAL.ts"] } };\n');
  const result = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", join(directory, "vitest.config.mjs")], { cwd: directory, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}

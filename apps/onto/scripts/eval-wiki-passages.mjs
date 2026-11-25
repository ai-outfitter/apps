import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const parent = resolve(process.argv[2] ?? tmpdir());
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(resolve(parent, "wiki-passage-eval-"));
const evidence = resolve(directory, "scenarios.jsonl");
writeFileSync(evidence, "");
const env = {
  ...process.env,
  WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? resolve(directory, "wrangler"),
  WIKI_PASSAGE_EVIDENCE: evidence,
};
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
const run = {
  issue: 268,
  sourceHead: head.stdout?.trim() || null,
  node: process.version,
  startedAt: new Date().toISOString(),
  steps: [],
  packageSha256: {},
};

function execute(name, command, args, log) {
  const file = resolve(directory, log);
  const fd = openSync(file, "w");
  let result;
  try {
    result = spawnSync(command, args, { cwd: repo, env, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  const passed = result.status === 0;
  run.steps.push({ name, command: [command, ...args], status: result.status, signal: result.signal, log, error: result.error?.message });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name} · ${file}\n`);
  if (!passed) process.stderr.write(readFileSync(file, "utf8").split("\n").slice(-70).join("\n"));
  return passed;
}

let passed = true;
for (const [app, workspace] of [["wiki", "app-wiki-map"], ["onto", "app-onto"]]) {
  passed = execute(`Build ${app}`, "npm", [
    "exec", "--workspace", `@ai-outfitter/${workspace}`, "--", "outfitter-app-build", "--mode", "operational",
  ], `build-${app}.log`);
  if (!passed) break;
  const artifact = resolve(repo, `apps/${app}/.outfitter/packages/operational.json`);
  run.packageSha256[app] = createHash("sha256").update(readFileSync(artifact)).digest("hex");
}
if (passed) passed = execute("Installed-worker eval", process.execPath, [
  "--import", "tsx", "--test", "--test-reporter=tap", "apps/onto/tests/wiki-passage-index.eval.test.ts",
], "test.tap");

writeFileSync(resolve(directory, "run.json"), JSON.stringify({
  ...run,
  finishedAt: new Date().toISOString(),
  status: passed ? "pass" : "fail",
}, null, 2) + "\n");
process.stdout.write(`Evidence · ${directory}\n`);
process.exitCode = passed ? 0 : 1;

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkApp } from "./apps.mjs";

// The adapter rewrites its workspace and lockfile: TOOLCHAIN must be disposable.
const [slug, directory] = process.argv.slice(2);
const { pkg } = checkApp(slug);
assert.ok(directory, "Usage: node scripts/toolchain.mjs APP DISPOSABLE_TOOLCHAIN");
const toolchain = resolve(directory);
assert.notEqual(toolchain, process.cwd());
const temporary = mkdtempSync(join(tmpdir(), "outfitter-app-ci-"));
const run = (command, args, cwd = toolchain) => execFileSync(command, args, { cwd, stdio: "inherit" });
try {
  const archive = join(temporary, "source.tar.gz");
  run("git", ["archive", "--format=tar.gz", "--prefix=outfitter-apps/", `--output=${archive}`, "HEAD"], process.cwd());
  run(process.execPath, ["scripts/build-app-repository.mjs", archive, slug]);
  // The adapter covers check, unit/integration tests and operational packaging.
  // Test preparation also requires the declared demo package.
  run(process.execPath, ["--import", "tsx", "scripts/build-apps.mjs", slug, "--mode", "demo"]);
  run("npm", ["exec", "--", "playwright", "install", "--with-deps", "chromium"]);
  run("npm", ["run", "test:e2e", "--workspace", pkg.name]);
} finally { rmSync(temporary, { recursive: true, force: true }); }

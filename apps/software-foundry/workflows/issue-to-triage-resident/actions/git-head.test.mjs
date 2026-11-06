import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitHead } from "./git-head.mjs";
test("upload evidence reads actual Git HEAD and follows a real new commit", () => {
  const cwd = mkdtempSync(join(tmpdir(), "foundry-head-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    assert.throws(() => gitHead(cwd));
    git("init", "-q");
    const commit = () =>
      git(
        "-c",
        "user.name=Adapter test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture",
      );
    commit();
    const first = gitHead(cwd);
    assert.equal(first, git("rev-parse", "HEAD"));
    commit();
    const second = gitHead(cwd);
    assert.notEqual(second, first);
    assert.equal(second, git("rev-parse", "HEAD"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

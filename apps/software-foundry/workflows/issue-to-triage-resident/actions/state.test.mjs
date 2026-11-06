import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAttempt } from "./state.mjs";
test("invalid context leaves no attempt; a complete existing attempt cannot be overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-attempt-"));
  const path = join(directory, "attempt.json");
  try {
    await assert.rejects(
      saveAttempt(path, { nodeId: "review", inputs: {} }),
      /resident/,
    );
    assert.deepEqual(await readdir(directory), []);
    const lease = {
      nodeId: "triage",
      inputs: { settings: { engineerProfile: "engineer" } },
    };
    await saveAttempt(path, lease);
    const original = await readFile(path, "utf8");
    await assert.rejects(
      saveAttempt(path, { ...lease, nodeId: "implement" }),
      /EEXIST/,
    );
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(JSON.parse(original).context.model, "gpt-6-luna");
    assert.deepEqual(await readdir(directory), ["attempt.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

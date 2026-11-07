import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergedTranscript, readSession, recordSessions, SESSIONS_BRANCH, sessionFiles } from "../sessions.mjs";

const message = (role: string, text: string, timestamp: number) =>
  ({ type: "message", timestamp: new Date(timestamp).toISOString(), message: { role, content: [{ type: "text", text }], timestamp } });

test("the merged transcript puts every agent's messages in time order, tagged by agent", () => {
  const lines = mergedTranscript([
    { agent: "implement", entries: [{ type: "session", id: "a" }, message("user", "Build it", 1_000), message("assistant", "Built", 3_000)] },
    { agent: "review", entries: [message("user", "Review it", 4_000), message("assistant", "Approved", 5_000)] },
    { agent: "triage", entries: [message("assistant", "Plan", 500)] },
  ]).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.agent, line.message.content[0].text]),
    [["triage", "Plan"], ["implement", "Build it"], ["implement", "Built"], ["review", "Review it"], ["review", "Approved"]]);
  assert.ok(lines.every((line) => line.type === "message_end"));
});

test("session files are found by runtime run id in any workspace folder", () => {
  const root = mkdtempSync(join(tmpdir(), "box-workspaces-"));
  const state = join(root, "box", "ws-1", ".outfitter");
  mkdirSync(state, { recursive: true });
  const id = "0b7e1c2a-0000-4000-8000-000000000001";
  writeFileSync(join(state, `workflow-${id}-triage.jsonl`), `${JSON.stringify(message("user", "Go", 1))}\nnot json\n`);
  writeFileSync(join(state, "workflow-other-triage.jsonl"), "{}\n");
  const files = sessionFiles(root, id);
  assert.equal(files.length, 1);
  assert.equal(readSession(files[0]).length, 1);
  assert.deepEqual(sessionFiles(join(root, "missing"), id), []);
});

test("sessions are written to /out and committed with Git LFS to the sessions branch", () => {
  const work = mkdtempSync(join(tmpdir(), "box-sessions-test-"));
  const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  run(work, "init", "--quiet", "--bare", "--initial-branch=main", "remote.git");
  mkdirSync(join(work, "seed"));
  run(join(work, "seed"), "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(work, "seed", "README.md"), "# Repo\n");
  run(join(work, "seed"), "add", "-A");
  run(join(work, "seed"), "commit", "--quiet", "-m", "init");
  run(join(work, "seed"), "push", "--quiet", join(work, "remote.git"), "main");
  const box = { out: join(work, "out"), remote: join(work, "remote.git"), log: () => {} };
  const requestId = "6f0c6f5e-1111-4222-8333-444455556666";
  const first = recordSessions(box, requestId, [{ agent: "implement", entries: [message("user", "Build", 1)] }]);
  const second = recordSessions(box, "7f0c6f5e-1111-4222-8333-444455556666", [{ agent: "Review 2", entries: [message("user", "Check", 2)] }]);
  assert.equal(first.branch, SESSIONS_BRANCH);
  assert.deepEqual(first.files.map((file) => file.path), [`sessions/${requestId}/implement.jsonl`]);
  assert.deepEqual(second.files.map((file) => file.path), ["sessions/7f0c6f5e-1111-4222-8333-444455556666/review-2.jsonl"]);
  assert.equal(readSession(join(box.out, "sessions", requestId, "implement.jsonl")).length, 1);
  assert.match(readFileSync(join(box.out, "sessions", requestId, "transcript.jsonl"), "utf8"), /"agent":"implement"/);
  // The branch holds both requests' sessions as LFS pointers; main is unchanged.
  const tree = run(join(work, "remote.git"), "ls-tree", "-r", "--name-only", SESSIONS_BRANCH).trim().split("\n");
  assert.deepEqual(tree.sort(), [".gitattributes", `sessions/${requestId}/implement.jsonl`, "sessions/7f0c6f5e-1111-4222-8333-444455556666/review-2.jsonl"]);
  assert.match(run(join(work, "remote.git"), "show", `${SESSIONS_BRANCH}:sessions/${requestId}/implement.jsonl`), /^version https:\/\/git-lfs/);
  assert.equal(run(join(work, "remote.git"), "ls-tree", "--name-only", "main").trim(), "README.md");
  assert.equal(second.commitSha, run(join(work, "remote.git"), "rev-parse", SESSIONS_BRANCH).trim());
});

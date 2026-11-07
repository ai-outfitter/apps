import assert from "node:assert/strict";
import test from "node:test";
import { evidenceBundle, nextVersion } from "../box/release.mjs";
import { nodeResults, runResult } from "../box/results.mjs";

const runId = "b443b27b-37cf-580d-a374-5c600f199d70";
const head = "a".repeat(40);
const merge = "b".repeat(40);
const request = {
  schemaVersion: 1, requestId: "3a7e9c1d-5b2f-4e8a-9d6c-1f0b2a3c4d5e", kind: "feature", title: "Add a subtract helper",
  problem: "p", acceptanceCriteria: [{ id: "export-subtract", text: "t" }], delivery: "pull_request",
};
const issue = { number: 1, url: "http://127.0.0.1:3300/box/repo/issues/1" };
const model = { provider: "luna", id: "gpt-6-luna" };

/** The box Forgejo after a landed run: one merged PR with a passing check and an approval. */
function forgejo(merged = true) {
  const pull = { number: 2, html_url: "http://127.0.0.1:3300/box/repo/pulls/2", title: "Add subtract helper", body: "Adds it.\n\nCloses #1",
    merged, merge_commit_sha: merged ? merge : null, merge_base: "c".repeat(40), head: { ref: "outfitter/issue-1-x", sha: head }, base: { ref: "main", sha: "d".repeat(40) } };
  const routes: Record<string, unknown> = {
    "/repos/box/repo/pulls?state=all&limit=50": [pull, { ...pull, number: 3, body: "unrelated" }],
    "/repos/box/repo/pulls/2/files?limit=50": [{ filename: "index.mjs", status: "changed" }, { filename: "index.test.mjs", status: "added" }],
    [`/repos/box/repo/commits/${head}/statuses?limit=50`]: [{ id: 1, context: "test", status: "failure" }, { id: 2, context: "test", status: "success" }],
    "/repos/box/repo/pulls/2/reviews?limit=50": [{ id: 4, state: "APPROVED", commit_id: head, user: { login: "reviewer" } }],
    "/repos/box/repo/pulls/2/commits?limit=50": [{ sha: head }],
  };
  return async (method: string, path: string) => {
    assert.equal(method, "GET");
    if (!(path in routes)) throw new Error(`unexpected ${path}`);
    return routes[path];
  };
}

test("node results are each node's newest report for the run", () => {
  const snapshots = [
    { prompt: `Workflow ${runId}, node triage`, startedAt: 1, status: "completed", result: { outputs: { result: { ready: true, summary: "Plan" } } } },
    { prompt: `Workflow ${runId}, node validate`, startedAt: 2, status: "failed", error: "stopped" },
    { prompt: `Workflow ${runId}, node validate`, startedAt: 3, status: "completed", result: { outputs: { result: { passed: true } } } },
    { prompt: "Workflow 00000000-0000-4000-8000-000000000000, node triage", startedAt: 4, status: "failed" },
  ];
  const nodes = nodeResults(snapshots, runId);
  assert.deepEqual(Object.keys(nodes), ["triage", "validate"]);
  assert.equal(nodes.validate.status, "completed");
});

test("a landed run's result names its PR, checks, review and merge", async () => {
  const nodes = { triage: { status: "completed", result: { ready: true, summary: "Plan" } }, implement: { status: "completed", result: { summary: "Implemented." } } };
  const checks = [{ name: "test", commands: [["npm", "ci"], ["npm", "test"]] }];
  const result = await runResult({ forgejo: forgejo(), repository: "box/repo", request, issue, run: { status: "complete" }, nodes, checks, model,
    startedAt: "2026-11-07T00:00:00.000Z", finishedAt: "2026-11-07T00:10:00.000Z" });
  assert.equal(result?.status, "landed");
  assert.equal(result?.change.mergeSha, merge);
  const pr = result?.change.pullRequest;
  assert.deepEqual(pr.changes.map((change: { path: string; change: string }) => [change.path, change.change]), [["index.mjs", "modified"], ["index.test.mjs", "added"]]);
  assert.deepEqual(result?.checks, [{ name: "test", command: "npm ci && npm test", conclusion: "success", commitSha: head }]);
  assert.deepEqual(result?.review, { verdict: "approved", reviewer: "reviewer", commitSha: head });
  assert.equal(pr.acceptanceCriteria[0].status, "met");
  assert.deepEqual(result?.triage, { plan: "Plan", questions: [] });
  assert.equal(await runResult({ forgejo: forgejo(), repository: "box/repo", request, issue, run: { status: "running" }, nodes, model, startedAt: "", finishedAt: "" }), undefined);
});

test("a run that ends without a merge is failed or needs details", async () => {
  const failed = await runResult({ forgejo: forgejo(false), repository: "box/repo", request, issue, run: { status: "failed" },
    nodes: { validate: { status: "failed", error: "Validation stopped" } }, model, startedAt: "", finishedAt: "" });
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.reason, "validate: Validation stopped");
  const question = await runResult({ forgejo: async () => [], repository: "box/repo", request, issue, run: { status: "complete" },
    nodes: { triage: { status: "completed", result: { ready: false, summary: "Which file?" } } }, model, startedAt: "", finishedAt: "" });
  assert.equal(question?.status, "needs_details");
  assert.deepEqual(question?.triage, { plan: "", questions: ["Which file?"] });
});

test("releases bump the highest semver tag and bundle every landed criterion", () => {
  assert.equal(nextVersion([], ["patch"]), "0.0.1");
  assert.equal(nextVersion(["v1.2.3", "v1.10.0", "nightly"], ["patch", "minor"]), "1.11.0");
  assert.equal(nextVersion(["1.0.0"], ["major"]), "2.0.0");
  const result = { checks: [{ name: "test", command: "npm test", conclusion: "success", commitSha: head }],
    change: { mergeSha: merge, pullRequest: { number: 2, acceptanceCriteria: [{ id: "export-subtract", status: "met", evidence: [] }] } } };
  const bundle = evidenceBundle({ tag: "v0.1.0", version: "0.1.0", commitSha: merge, model,
    build: { command: "git archive", image: "outfitter/foundry-box:dev", startedAt: "s", finishedAt: "f" },
    released: [{ request, result }], artifacts: [{ name: "repo-0.1.0.tar.gz", uri: "s3://foundry/releases/v0.1.0/repo-0.1.0.tar.gz", sha256: "e".repeat(64), bytes: 10 }] });
  assert.deepEqual(bundle.requests, [{ requestId: request.requestId, pullRequest: 2, commits: [merge] }]);
  assert.deepEqual(bundle.criteria, [{ requestId: request.requestId, id: "export-subtract", status: "met", evidence: [] }]);
});

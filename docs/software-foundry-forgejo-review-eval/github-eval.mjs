import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTool } from "/planwork/mcp.mjs";
import { appId, appSlug, githubInstallationId, reviewerId } from "./github-fixture.mjs";
import { inspectCandidate, inventory, issue } from "./fixture.mjs";
import { sessionRequest, waitFor } from "./grants.mjs";
import { reviewRows, seedPriorReview } from "./recovery-seed.mjs";

const app = "software-foundry";
const reviewDocument = "ReviewIssue";
const progressDocument = "IssueReview";
const unknownId = "00000000-0000-5000-a000-000000000001";

function jsonLines(path) {
  return readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
}

async function authorizeGitHub(root, cookie) {
  const headers = { cookie, origin: root };
  const start = await fetch(`${root}/plugins/github`, { method: "POST", headers, redirect: "manual" });
  assert.ok([302, 303, 307].includes(start.status), `GitHub authorization start ${start.status}: ${await start.text()}`);
  const target = new URL(start.headers.get("location"));
  assert.equal(target.origin, "https://github.com");
  assert.equal(target.pathname, "/login/oauth/authorize");
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  const callback = new URL(target.searchParams.get("redirect_uri"));
  writeFileSync("/box/github-fixture-oauth.json", JSON.stringify({
    redirect: callback.href, challenge: target.searchParams.get("code_challenge"),
  }), { mode: 0o600 });
  callback.search = new URLSearchParams({ state: target.searchParams.get("state"), code: "fixture-code" });
  const finish = await fetch(callback, { headers, redirect: "manual" });
  assert.ok([302, 303, 307].includes(finish.status), `GitHub authorization callback ${finish.status}: ${await finish.text()}`);
}

export async function exerciseGitHub({ box, db, auth, root, cookie, mcp, report }, workflowId, model, gradeResolution) {
  const out = name => join(box.out, name);
  const scope = "box";
  const pin = { repository: issue.repository, repositoryId: report.repositoryId, issueNumber: issue.number,
    baseRef: report.baseRef, baseSha: report.baseSha };
  const runs = () => db.prepare("SELECT id, workflowId, status FROM workflow_runs WHERE installationId=? ORDER BY id")
    .all(report.installation.id);
  const mutate = (input, scopeName = scope) => callTool(mcp, "graph_mutate",
    { scope: scopeName, app, document: reviewDocument, variables: { input } });
  const start = (pins = pin, scopeName = scope) => mutate({ action: "START", provider: "GITHUB", ...pins }, scopeName);
  const recover = (runId, scopeName = scope) => mutate({ action: "RECOVER", runId }, scopeName);
  const query = (runId, scopeName = scope) => callTool(mcp, "graph_query",
    { scope: scopeName, app, document: progressDocument, variables: { runId }, includeIdentifiers: true });
  const receipt = (result, field = "reviewIssue") => {
    assert.equal(result.refused, false, result.text);
    const value = result.value?.data?.[field];
    assert.ok(value?.original?.id, result.text);
    assert.equal(value.provider, "GITHUB");
    assert.deepEqual(value.target, pin);
    return value;
  };

  assert.equal((await start()).refused, true);
  assert.deepEqual(runs(), []);
  await authorizeGitHub(root, cookie);
  const configured = await box.operator({
    operation: "configure-issue-review", provider: "GITHUB", repository: pin.repository,
    repositoryId: pin.repositoryId, reviewer: "reviewer", implementerModel: model, reviewerModel: model,
  });
  assert.equal(configured.workflow, workflowId);
  assert.equal(configured.repository, pin.repository);
  report.bindings = { implementer: configured.implementer, reviewer: configured.reviewer };
  assert.notEqual(configured.implementer, configured.reviewer);
  const bindings = db.prepare(`SELECT id, actor, transport FROM workflow_executor_bindings
    WHERE installationId = ? AND workflowId = ? ORDER BY actor`).all(report.installation.id, workflowId);
  assert.deepEqual(bindings.map(binding => binding.id), [configured.implementer, configured.reviewer]);
  for (const row of bindings) {
    const { workspace, context } = JSON.parse(row.transport);
    assert.equal(workspace.checkout, "github-pinned");
    assert.equal(workspace.inferenceProvider, "spark");
    assert.equal(workspace.repository, pin.repository);
    assert.equal(workspace.resource, String(pin.repositoryId));
    assert.equal(context.model, model);
  }
  const chain = await sessionRequest(root, cookie, "/o/box/api/inference/chain", "PUT",
    { providers: ["openai", "spark"], interactiveFallback: true });
  assert.equal(chain.status, 200, JSON.stringify(chain));
  const discovery = await callTool(mcp, "graph_documents", { scope, search: progressDocument, schema: true });
  assert.equal(discovery.refused, false, discovery.text);
  assert.ok(discovery.value?.apps?.[app]?.queries?.[progressDocument]?.schema);
  report.documents = [reviewDocument, progressDocument];
  for (const [name, invalid, requestedScope] of [
    ["wrong-tenant", pin, "unrelated-tenant"],
    ["wrong-repository-id", { ...pin, repositoryId: pin.repositoryId + 1 }],
    ["wrong-base-sha", { ...pin, baseSha: "f".repeat(40) }],
  ]) {
    const result = await start(invalid, requestedScope);
    assert.equal(result.refused, true, `${name}: ${result.text}`);
  }
  assert.equal((await recover(unknownId)).refused, true);
  assert.equal((await query(unknownId)).refused, true);
  assert.deepEqual(runs(), []);
  assert.ok(!existsSync(out("provider.jsonl")));
  assert.deepEqual(await inventory(auth.admin), report.before);
  writeFileSync(out("provider-context.json"), JSON.stringify({ database: box.databases.platform,
    installationId: report.installation.id, workflowId, pin }));

  let originalId;
  let activeId;
  let original;
  if (report.case === "github-recovery") {
    const seeded = seedPriorReview(box, report, pin, workflowId, { appId, appSlug, githubInstallationId, reviewerId });
    originalId = seeded.runId;
    report.legacy = seeded.migration;
    original = reviewRows(box, report.installation.id)[0];
    const prior = receipt(await query(originalId), "issueReview");
    assert.equal(prior.original.status, "failed");
    assert.equal(prior.recovery, null);
    assert.deepEqual(receipt(await start()), prior);
    assert.equal((await recover(originalId, "unrelated-tenant")).refused, true);
    const overlap = await Promise.all(Array.from({ length: 3 }, () => recover(originalId)));
    activeId = receipt(overlap[0]).recovery.id;
    assert.notEqual(activeId, originalId);
    assert.ok(overlap.every(result => receipt(result).recovery.id === activeId));
  } else {
    const started = receipt(await start());
    originalId = activeId = started.original.id;
    assert.equal(started.recovery, null);
    assert.equal((await start({ ...pin, baseRef: "main" })).refused, true);
    assert.equal(receipt(await start()).original.id, originalId);
  }

  report.settled = await waitFor(() => runs().find(row => row.id === activeId &&
    ["complete", "failed", "cancelled"].includes(row.status)), "GitHub review settlement", 240000);
  const progress = receipt(await query(originalId), "issueReview");
  report.progress = progress;
  assert.equal(report.settled.status, "complete", JSON.stringify(progress));
  assert.equal(progress.original.id, originalId);
  assert.equal(progress.original.status, original ? "failed" : "complete");
  if (original) {
    assert.equal(progress.recovery.id, activeId);
    assert.equal(progress.recovery.status, "complete");
    assert.deepEqual(receipt(await recover(originalId)), progress);
    assert.deepEqual(reviewRows(box, report.installation.id).find(row => row.runId === originalId), original);
  } else {
    assert.equal(progress.recovery, null);
    assert.deepEqual(receipt(await start()), progress);
  }
  assert.deepEqual(runs().map(row => row.id).sort(), (original ? [originalId, activeId] : [activeId]).sort());
  const beforeRead = jsonLines(out("github-requests.jsonl")).filter(entry => entry.effect);
  assert.deepEqual(receipt(await query(originalId), "issueReview"), progress);
  assert.deepEqual(jsonLines(out("github-requests.jsonl")).filter(entry => entry.effect), beforeRead);
  assert.deepEqual(beforeRead.map(entry => [entry.actor, entry.effect, entry.status]), [
    ["installation", "branch", 201], ["installation", "commit", 200],
    ["installation", "draft", 201], ["reviewer", "review", 200],
  ]);

  report.final = await inventory(auth.admin);
  assert.deepEqual(report.final.issues, report.before.issues);
  assert.equal(report.final.pulls.length, 1);
  const [pull] = report.final.pulls;
  assert.equal(pull.baseRef, pin.baseRef);
  assert.equal(pull.baseSha, pin.baseSha);
  assert.equal(pull.baseRepositoryId, pin.repositoryId);
  assert.equal(pull.headRepositoryId, pin.repositoryId);
  assert.equal(pull.state, "open");
  assert.equal(pull.merged, false);
  assert.equal(pull.draft, true);
  assert.equal(pull.headRef, `outfitter-review-${activeId}`);
  assert.deepEqual(report.final.refs, { ...report.before.refs, [pull.headRef]: pull.head });
  assert.equal(pull.reviews.length, 1);
  assert.equal(pull.reviews[0].head, pull.head);
  assert.equal(progress.candidate.number, pull.number);
  assert.equal(progress.candidate.headSha, pull.head);
  assert.equal(progress.candidate.branch, pull.headRef);
  assert.equal(progress.review.reviewer.id, reviewerId);
  assert.equal(progress.review.headSha, pull.head);
  assert.equal(progress.review.verdict, "approved");
  report.git = inspectCandidate(auth.admin, pin.baseSha, pull.head, pull.headRef);
  assert.deepEqual(report.git, { head: pull.head, parents: [pin.baseSha], files: ["README.md"],
    readme: "# Synthetic lamp\n\nSetting: amber." });
  const nativeFetches = jsonLines(out("github-git.jsonl"));
  assert.deepEqual(nativeFetches.map(event => event.pins.map(pin => pin.split(":")[0]).sort()),
    [[pin.baseSha], [pin.baseSha, pull.head].sort()]);
  const events = jsonLines(out("provider.jsonl"));
  assert.deepEqual(events.filter(event => event.event === "error"), []);
  assert.deepEqual(events.filter(event => event.event === "response").map(({ actor, runId, checkout }) => [actor, runId, checkout]),
    [["implement", activeId, pin.baseSha], ["review", activeId, pull.head]]);
  gradeResolution(db, out, report, activeId, ["openai", "spark"], ["implement", "review"]);
  const requests = jsonLines(out("github-requests.jsonl"));
  assert.deepEqual(requests.filter(entry => entry.unexpected), []);
  report.progress = progress;
  report.githubWrites = beforeRead;
}

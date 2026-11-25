import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { anchor, charts, repositories, admin, addChartsRepository, openPlatform, registerForgejoHook, removeAppIssueGrant, setCoverage, useReadOnlyBotToken } from "./box-fixture.mjs";
import { signIn, oauthToken, mcpClient, callTool } from "./mcp.mjs";

export const app = "software-foundry";
export const title = "Synthetic Keystone planning eval";
export const platformModel = true;

const fixture = JSON.parse(readFileSync(new URL("./fixtures/requests.json", import.meta.url)));
const workflow = "foundry-plan-work";
const request = (id, extra = {}) => {
  const { requestId, title, description, acceptanceCriteria } = fixture[id];
  const body = [title, description, ...(acceptanceCriteria ?? [])].filter(Boolean).join("\n\n");
  return { requestId, request: body, repositories, anchorRepository: anchor, ...extra };
};

const rows = (db) => db.prepare(
  "SELECT id, workflowId, status FROM workflow_runs WHERE installationId IN (SELECT id FROM app_installations WHERE template = 'software-foundry') ORDER BY id",
).all().map((row) => ({ ...row }));

function fileJson(path, jsonLines = false) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  return jsonLines ? text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : JSON.parse(text);
}

async function eventually(read, message) {
  const deadline = Date.now() + 30_000;
  do {
    const result = await read();
    if (result) return result;
    await sleep(200);
  } while (Date.now() < deadline);
  throw new Error(message);
}

function graph(mcp, tool, document, input) {
  return callTool(mcp, tool, {
    scope: "box", app, document, variables: { input }, ...(tool === "graph_query" ? { includeIdentifiers: true } : {}),
  });
}

function accepted(reply, field) {
  assert.equal(reply.refused, false, reply.text);
  assert.ok(reply.value?.data?.[field], reply.text);
  return reply.value.data[field];
}

function bodyOf(reply) {
  return JSON.stringify(reply.value ?? reply.text);
}

async function repoState(box, repo) {
  const path = `/repos/${repo}`;
  const [branches, issues, pulls] = await Promise.all([
    admin(box, "GET", `${path}/branches`),
    admin(box, "GET", `${path}/issues?state=all&type=issues`),
    admin(box, "GET", `${path}/issues?state=all&type=pulls`),
  ]);
  return { branches: branches.map(({ name, commit }) => ({ name, sha: commit.id })), issues, pulls };
}

function boxArtifactUrl(link, box) {
  const url = new URL(link);
  assert.equal(url.hostname, "software-foundry.box.outfitter.localhost");
  assert.match(url.pathname, /^\/api\/apps\/software-foundry\/plans\/[a-f0-9-]+$/);
  url.protocol = "http:";
  url.port = String(box.port);
  return url;
}

async function checkArtifact({ result, caseId, cookie, box, before, query }) {
  assert.equal(result.run.workflow, workflow);
  assert.deepEqual(result.repositories, repositories);
  assert.equal(result.artifacts.length, 1);
  const artifact = result.artifacts[0];
  assert.equal(artifact.kind, "plan");
  const url = boxArtifactUrl(artifact.url, box);
  const unauthorized = await fetch(url, { redirect: "manual" });
  assert.ok(!unauthorized.ok, "anonymous callers cannot download the artifact");
  await unauthorized.body?.cancel();
  const downloaded = await fetch(url, { headers: { cookie }, redirect: "manual" });
  assert.equal(downloaded.status, 200, await downloaded.clone().text());
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);

  const inspected = accepted(await query(fixture[caseId].requestId), "foundryPlan");
  const plan = JSON.parse(bytes);
  assert.deepEqual(inspected.plan, plan);
  assert.equal(inspected.run.id, result.run.id);
  assert.equal(plan.plan.title, fixture[caseId].title);
  assert.deepEqual(plan.sources.map(({ name, commitSha }) => [name, commitSha]),
    repositories.map((repo) => [repo, before[repo].branches[0].sha]));
  assert.deepEqual(plan.citations.map(({ repository, path }) => [repository, path]),
    repositories.map((repo) => [repo, "README.md"]));
  for (const citation of plan.citations) {
    assert.match(citation.url, new RegExp(`/src/commit/${before[citation.repository].branches[0].sha}/`));
  }
  writeFileSync(join(box.out, `${caseId}-plan.json`), bytes);
  return { run: result.run.id, sha256: artifact.sha256, sources: plan.sources, citations: plan.citations };
}

function refused(reply, match) {
  assert.ok(reply.refused || reply.value?.data?.planWork?.status === "denied", bodyOf(reply));
  assert.match(bodyOf(reply), match);
}

export async function run(box) {
  const report = { scope: "box", repositories, anchor, cases: {} };
  const root = `http://outfitter.localhost:${box.port}`;
  const db = openPlatform(box);
  const writes = () => fileJson(join(box.out, "forgejo-writes.json"));
  const inference = () => fileJson(join(box.out, "inference.jsonl"), true);
  const webhooks = () => fileJson(join(box.out, "webhooks.jsonl"), true);
  const snapshot = () => ({ runs: rows(db), writes: writes(), inference: inference() });
  let failure;
  try {
    await addChartsRepository(box, db);
    const before = Object.fromEntries(await Promise.all(repositories.map(async repo => [repo, await repoState(box, repo)])));
    for (const repo of repositories) {
      assert.deepEqual(before[repo].branches.map(({ name }) => name), ["main"]);
      assert.deepEqual(before[repo].issues, []);
      assert.deepEqual(before[repo].pulls, []);
    }

    const cookie = await signIn(root);
    const grant = await oauthToken(root, cookie, "apps actions entities organizations offline_access");
    const mcp = mcpClient(grant);
    const catalog = await mcp("tools/list", {});
    assert.ok(catalog.result?.tools.some(({ name }) => name === "graph_mutate"), JSON.stringify(catalog));
    for (const document of ["PlanWork", "FoundryPlan"]) {
      const discovery = await callTool(mcp, "graph_documents", { scope: "box", search: document, schema: true });
      assert.equal(discovery.refused, false, discovery.text);
      assert.ok(JSON.stringify(discovery.value).includes(document), discovery.text);
    }
    const submit = (input) => graph(mcp, "graph_mutate", "PlanWork", input);
    const query = (requestId) => graph(mcp, "graph_query", "FoundryPlan", { requestId });
    const opts = { cookie, box, before, query };

    // Configure normal issue-trigger coverage before opening any planning issue.
    const subscribed = await box.operator({ operation: "configure", repository: anchor, reviewer: "reviewer", ci: "workspace" });
    assert.equal(subscribed.workflow, "issue-to-merge-actions-ci");
    await registerForgejoHook(box);
    const invalidHook = await fetch(`${root}/api/webhooks/foundry-planning-eval`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(invalidHook.status, 401);
    await invalidHook.body?.cancel();
    assert.deepEqual(webhooks(), []);

    const pristine = snapshot();
    refused(await submit(request("denied", { anchorRepository: "box/outside-scope" })), /anchor/i);
    refused(await submit(request("denied", { anchorRepository: undefined })), /anchor/i);
    setCoverage(db, [anchor]);
    try {
      refused(await submit(request("denied")), /repository|scope|denied|forbidden/i);
      assert.deepEqual(snapshot(), pristine);
    } finally {
      setCoverage(db, repositories);
    }

    await admin(box, "PATCH", `/repos/${anchor}`, { has_issues: false });
    try {
      refused(await submit(request("denied")), /issue|permission|grant|denied|forbidden|unavailable/i);
      assert.deepEqual(snapshot(), pristine);
    } finally {
      await admin(box, "PATCH", `/repos/${anchor}`, { has_issues: true });
    }

    const restoreIssueGrant = removeAppIssueGrant(db);
    try {
      refused(await submit(request("denied")), /issue|permission|grant|denied|forbidden/i);
      assert.deepEqual(snapshot(), pristine);
    } finally {
      restoreIssueGrant();
    }

    const restoreBotToken = await useReadOnlyBotToken(db);
    try {
      refused(await submit(request("denied")), /issue|permission|grant|denied|forbidden/i);
      assert.deepEqual(snapshot(), pristine);
      report.cases.preflight = { wrongAnchor: true, missingAnchor: true, deniedRead: true,
        issuesDisabled: true, deniedAppWrite: true, deniedBotWrite: true, dispatched: 0 };

      const bug = accepted(await submit(request("bug", { anchorRepository: undefined, kind: "bug", createIssue: false })), "planWork");
      assert.equal(bug.status, "artifacts_only", JSON.stringify(bug));
      assert.equal(bug.kind, "bug");
      assert.equal(bug.anchorRepository, null);
      assert.equal(bug.issue, null);
      assert.deepEqual(writes(), []);
      report.cases.bug = await checkArtifact({ ...opts, result: bug, caseId: "bug" });
      const replayBug = accepted(await submit(request("bug", { repositories: [...repositories].reverse(),
        anchorRepository: undefined, kind: "bug", createIssue: false })), "planWork");
      assert.equal(replayBug.run.id, bug.run.id);
      assert.deepEqual(replayBug.artifacts, bug.artifacts);
      assert.deepEqual(writes(), []);
      report.cases.bug.status = bug.status;
    } finally {
      restoreBotToken();
    }

    const feature = accepted(await submit(request("feature")), "planWork");
    assert.equal(feature.status, "published", JSON.stringify(feature));
    assert.equal(feature.kind, "feature");
    assert.equal(feature.anchorRepository, anchor);
    assert.ok(feature.issue.created);
    const initialIssue = await box.forgejo("GET", `/repos/${anchor}/issues/${feature.issue.number}`);
    assert.equal(initialIssue.title, fixture.feature.title);
    assert.match(initialIssue.body, /## Acceptance criteria/);
    assert.ok(initialIssue.body.includes(`<!-- outfitter:foundry-plan:${feature.run.id} -->`));
    report.cases.feature = await checkArtifact({ ...opts, result: feature, caseId: "feature" });
    const replay = accepted(await submit(request("feature", { repositories: [...repositories].reverse() })), "planWork");
    assert.deepEqual([replay.run.id, replay.issue.number, replay.artifacts], [feature.run.id, feature.issue.number, feature.artifacts]);
    const unchanged = snapshot();
    refused(await submit(request("feature", { anchorRepository: charts })), /bound|conflict|inputs|different/i);
    assert.deepEqual(snapshot(), unchanged);
    report.cases.feature.issue = feature.issue;

    setCoverage(db, [anchor]);
    try {
      assert.ok((await query(fixture.feature.requestId)).refused, "revoked source coverage stops MCP artifact readback");
      const denied = await fetch(boxArtifactUrl(feature.artifacts[0].url, box), { headers: { cookie }, redirect: "manual" });
      assert.ok(!denied.ok, "revoked source coverage stops HTTP artifact readback");
      await denied.body?.cancel();
    } finally {
      setCoverage(db, repositories);
    }

    writeFileSync(join(box.out, "drop-next-issue"), "");
    const uncertain = accepted(await submit(request("ambiguous")), "planWork");
    assert.equal(uncertain.status, "publication_uncertain", JSON.stringify(uncertain));
    const lookupFailure = join(box.out, "fail-next-lookup");
    writeFileSync(lookupFailure, "");
    const missed = accepted(await submit(request("ambiguous", { repositories: [...repositories].reverse() })), "planWork");
    assert.equal(missed.status, "publication_uncertain", JSON.stringify(missed));
    assert.equal(missed.run.id, uncertain.run.id);
    assert.equal(existsSync(lookupFailure), false, "the retry attempted a read-only marker lookup");
    assert.equal(writes().length, 2, "unavailable lookup did not authorize a second POST");
    const recovered = accepted(await submit(request("ambiguous", { repositories: [...repositories].reverse() })), "planWork");
    assert.equal(recovered.status, "published", JSON.stringify(recovered));
    assert.equal(recovered.issue.created, false);
    assert.equal(recovered.run.id, uncertain.run.id);
    assert.deepEqual(recovered.artifacts, uncertain.artifacts);
    const again = accepted(await submit(request("ambiguous")), "planWork");
    assert.deepEqual([again.run.id, again.issue.number], [recovered.run.id, recovered.issue.number]);
    report.cases.ambiguous = await checkArtifact({ ...opts, result: recovered, caseId: "ambiguous" });
    report.cases.ambiguous.issue = recovered.issue;

    const deliveries = await eventually(() => webhooks().length === 2 && webhooks(), "Forgejo did not deliver both signed issue events");
    const bot = await box.forgejo("GET", "/user");
    for (const delivery of deliveries) {
      assert.equal(delivery.signatureVerified, true);
      assert.equal(delivery.authorId, bot.id);
      assert.equal(delivery.result.outcome, "declined", JSON.stringify(delivery));
      assert.match(delivery.result.reason, /plan/i);
    }
    assert.deepEqual(deliveries.map(({ issue }) => issue).sort(), [feature.issue.number, recovered.issue.number].sort());
    assert.equal(new Set(deliveries.map(({ deliveryId }) => deliveryId)).size, 2);

    const after = Object.fromEntries(await Promise.all(repositories.map(async repo => [repo, await repoState(box, repo)])));
    for (const repo of repositories) {
      assert.deepEqual(after[repo].branches, before[repo].branches);
      assert.deepEqual(after[repo].pulls, []);
    }
    assert.deepEqual(after[charts].issues, []);
    assert.deepEqual(after[anchor].issues.map(({ number }) => number).sort(), [feature.issue.number, recovered.issue.number].sort());
    assert.deepEqual(writes().map(({ path, status, responseLost }) => [path, status, responseLost]), [
      [`/api/v1/repos/${anchor}/issues`, 201, false],
      [`/api/v1/repos/${anchor}/issues`, 201, true],
    ]);
    assert.deepEqual(inference().map((row) => row.case), ["bug", "feature", "ambiguous"]);
    const finalRuns = rows(db);
    assert.deepEqual(finalRuns.map(({ id }) => id).sort(), Object.values(report.cases).flatMap(item => item.run ?? []).sort());
    assert.ok(finalRuns.every(({ workflowId, status }) => workflowId === workflow && status === "complete"), JSON.stringify(finalRuns));
    const slots = db.prepare("SELECT value, complete FROM workflow_run_slots WHERE runId = ? AND slot = 'plan.outputs.result'");
    for (const { id } of finalRuns) {
      const slot = slots.get(id);
      assert.equal(slot?.complete, 1);
      assert.equal(JSON.parse(slot.value).run.id, id);
    }
    report.runs = finalRuns;
    report.webhooks = deliveries;
    report.writes = writes();
    report.inference = inference();
    report.repositoriesAfter = Object.fromEntries(repositories.map(repo => [repo, {
      branches: after[repo].branches, pulls: after[repo].pulls.length, issues: after[repo].issues.length,
    }]));
    report.status = "passed";
  } catch (error) {
    failure = error;
    report.status = "failed";
    report.error = error.message;
    console.error(error);
  } finally {
    db.close();
    writeFileSync(join(box.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await box.finish(failure);
  }
}

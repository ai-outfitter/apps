import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { callTool, mcpClient, oauthToken, signIn } from "/planwork/mcp.mjs";
import { api, credentials, grantReviewerReadOnly, inventory, issue, pushFixtureCommit, repoPath, seedIssue } from "./fixture.mjs";

import { exerciseInstalled } from "./installed.mjs";
import { exerciseGrants, exerciseRevokedGrant, grantRepositories } from "./grants.mjs";

export const app = "software-foundry";
export const title = "Synthetic Forgejo review eval";
export const platformModel = true;

async function nativeRoundTrip(auth, report) {
  const head = pushFixtureCommit(auth.worker, "main", "synthetic-review", "# Synthetic lamp\n\nSetting: amber.\n");
  const pull = await api(auth.worker, `${repoPath}/pulls`, "POST", {
    base: "main", head: "synthetic-review", title: "Record synthetic lamp setting", body: "Synthetic review fixture.",
  });
  await api(auth.reviewer, `${repoPath}/pulls/${pull.number}/reviews`, "POST", {
    event: "APPROVED", commit_id: head, body: "Verified the synthetic lamp setting at this commit.",
  });
  const after = await inventory(auth.admin);
  assert.deepEqual(after.issues, report.before.issues);
  assert.deepEqual(after.refs, { main: report.baseSha, "synthetic-review": head });
  assert.equal(after.pulls.length, 1);
  const [result] = after.pulls;
  assert.equal(result.state, "open");
  assert.equal(result.merged, false);
  assert.equal(result.baseRepositoryId, report.repositoryId);
  assert.equal(result.headRepositoryId, report.repositoryId);
  assert.equal(result.baseRef, "main");
  assert.equal(result.baseSha, report.baseSha);
  assert.equal(result.head, head);
  assert.equal(result.author, report.actors.worker.id);
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].head, head);
  assert.equal(result.reviews[0].actor, report.actors.reviewer.id);
  assert.equal(result.reviews[0].state, "APPROVED");
  report.final = after;
}

export async function run(box) {
  const report = { case: process.env.FOUNDRY_REVIEW_CASE, startedAt: new Date().toISOString() };
  const db = new DatabaseSync(box.databases.platform, { readOnly: true });
  db.exec("PRAGMA busy_timeout=5000");
  let failure;
  try {
    const auth = credentials(box);
    const actor = ({ id, login }) => ({ id, login });
    report.actors = {
      worker: actor(await api(auth.worker, "/user")), reviewer: actor(await api(auth.reviewer, "/user")),
    };
    assert.notEqual(report.actors.worker.id, report.actors.reviewer.id);
    assert.equal(report.actors.worker.login, "outfitter");
    assert.equal(report.actors.reviewer.login, "reviewer");
    report.repositoryId = (await seedIssue(box, auth)).repositoryId;
    report.issueNumber = issue.number;
    const sharedRecovery = report.case.startsWith("restart-") || report.case.startsWith("recovery-") || report.case.startsWith("github-");
    if (sharedRecovery) {
      report.reviewerPermissions = await grantReviewerReadOnly(auth);
    }
    report.before = await inventory(auth.admin);
    report.baseSha = readFileSync(join(box.out, "base.sha"), "utf8").trim();
    report.baseRef = (report.case === "slash-base" || sharedRecovery) ? "release/review-fixture" : "main";
    const expectedRefs = { main: report.baseSha, [report.baseRef]: report.baseSha };
    assert.deepEqual(report.before.refs, expectedRefs);
    assert.deepEqual(report.before.pulls, []);
    assert.equal(report.before.issues.length, 1);
    const grantCase = report.case.startsWith("grants");
    const repositories = grantCase ? await grantRepositories(auth) : null;
    writeFileSync(join(box.out, "fixture-ready"), "");
    report.installation = db.prepare("SELECT id, organizationId, activeHash FROM app_installations WHERE template = ? AND organizationId IS NOT NULL").get(app);
    assert.ok(report.installation?.activeHash, "Foundry is installed and active");
    const root = `http://outfitter.localhost:${box.port}`;
    const cookie = await signIn(root);
    const grant = await oauthToken(root, cookie, "apps actions entities organizations offline_access");
    assert.ok([`${root}/mcp`, `http://localhost:${box.port}/mcp`].includes(grant.resource));
    const mcp = mcpClient(grant);
    const discover = async (document) => {
      const response = await callTool(mcp, "graph_documents", { scope: "box", search: document, schema: true });
      assert.equal(response.refused, false, "OAuth discovery succeeded");
      const catalog = response.value?.apps?.[app];
      const published = catalog?.mutations?.[document];
      return published?.schema && (published.scopes ?? catalog.scopes).includes("box");
    };
    let document = "PlanWork";
    if (report.case !== "native" && !grantCase) {
      document = await discover("ReviewIssue") ? "ReviewIssue" : "ReviewForgejoIssue";
      if (sharedRecovery) assert.equal(document, "ReviewIssue");
    }
    assert.ok(await discover(document), `Installed box-scope discovery advertises mutation ${document} with its schema`);
    report.discovered = document;
    if (document === "ReviewIssue") {
      const published = JSON.parse(readFileSync("/package/documents.json", "utf8")).find(entry => entry.name === document);
      assert.equal(published?.query, "mutation ReviewIssue($input: ReviewIssueInput!) {\n  reviewIssue(input: $input)\n}");
      report.reviewDocumentHash = published.hash;
    }
    if (report.case === "native") await nativeRoundTrip(auth, report);
    else if (grantCase) {
      const exercise = report.case === "grants" ? exerciseGrants : exerciseRevokedGrant;
      await exercise({ box, db, root, cookie, report, repositories, auth });
      report.final = await inventory(auth.admin);
      assert.deepEqual(report.final, report.before);
    } else await exerciseInstalled({ box, db, auth, root, cookie, mcp, report });
    const requests = readFileSync(join(box.out, "forgejo-requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(requests.every(entry => !entry.blocked), "No forbidden Forgejo writes were attempted");
    assert.equal(requests.filter(entry => entry.method === "POST" && entry.path.includes("/issues")).length, 0);
    assert.equal(existsSync(join(box.out, "decoy.jsonl")), false, "Alternate provider was unused");
    report.outcome = "pass";
  } catch (error) {
    failure = error;
    report.outcome = "fail";
    report.error = error.stack;
    try {
      if (report.installation) {
        report.runDiagnostics = db.prepare(`SELECT r.id, r.workflowId, r.status, a.nodeId, a.state
          FROM workflow_runs r LEFT JOIN workflow_node_attempts a ON a.runId = r.id
          WHERE r.installationId = ? ORDER BY a.nodeId`).all(report.installation.id);
      }
      const gateway = new DatabaseSync(box.databases.gateway, { readOnly: true });
      gateway.exec("PRAGMA busy_timeout=1000");
      try {
        report.runtimeDiagnostics = gateway.prepare("SELECT id, snapshot FROM runs").all().map(({ id, snapshot }) => {
          const state = JSON.parse(snapshot);
          return { id, status: state.status, error: state.error };
        });
      } finally { gateway.close(); }
    } catch { /* Preserve the original failure if a fixture failed before the runtime schema loaded. */ }
  } finally {
    db.close();
    report.finishedAt = new Date().toISOString();
    writeFileSync(join(box.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await box.finish(failure);
  }
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { admin } from "./box-fixture.mjs";

export const cases = JSON.parse(readFileSync(new URL("./fixtures/legacy-cases.json", import.meta.url)));
const message = "Foundry could not produce a verified plan from the selected evidence.";
const typedMessage = "Planning inference did not return a structured answer.";
const workflowId = "foundry-plan-work";
const outputSlot = "plan.outputs.result";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function openFoundryDatabase(box, installation) {
  const path = join(dirname(box.databases.platform), "apps", installation.id);
  for (const file of readdirSync(path, { recursive: true }).filter(name => name.endsWith(".sqlite"))) {
    const db = new DatabaseSync(join(path, file));
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'foundry_plans'").get()) {
      db.exec("PRAGMA busy_timeout=5000");
      return db;
    }
    db.close();
  }
  throw new Error("The disposable installed Foundry database is unavailable");
}

function ledger(db, run, status, httpStatus, reason, attempt) {
  db.prepare(`INSERT INTO inference_usage_records
    (id, requestKey, attempt, workloadKind, workloadId, runtime, userId, organizationId,
     providerKind, model, credentialOwnerKind, payerKind, attemptStatus, httpStatus,
     costStatus, unavailableReason, pricingSource, createdAt, updatedAt)
    VALUES (?, ?, ?, 'workflow', ?, 'node', ?, ?, 'outfitter', 'GLM-5.3-Flash-EXL3', 'platform',
      'platform', ?, ?, 'unavailable', ?, 'none', ?, ?)`)
    .run(`${run.id}-meter-${attempt}`, `workflow:${run.id}:legacy-fixture`, attempt, run.id,
      run.userId, run.orgId, status, httpStatus, reason, run.at, run.at);
}

export function seedWorkflow(platform, input, installation, definition, run, name) {
  const { requestId, repositories, createIssue, anchorRepository = null } = input;
  const lost = name === "lostCollect";
  platform.prepare(`INSERT INTO workflow_runs
    (id, workflowId, version, definition, definitionHash, createdBy, organizationId, installationId, status, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(run.id, workflowId, definition.version, JSON.stringify(definition), digest(definition), run.userId,
      run.orgId, installation.id, lost || ["runningLegacy", "interruptedDraft"].includes(name) ? "running" : "complete", run.at, run.at);
  const slots = {
    "plan.inputs.requestId": requestId,
    "plan.inputs.repositories": repositories,
    "plan.inputs.anchorRepository": anchorRepository,
    "plan.inputs.createIssue": createIssue,
  };
  if (!lost && !["missingReceipt", "runningLegacy", "interruptedDraft"].includes(name)) slots[outputSlot] = {
    status: "failed", repositories, anchorRepository,
    run: { id: name === "contradictoryReceipt" ? cases.missingReceipt[1] : run.id, workflow: workflowId,
      url: "https://software-foundry.box.outfitter.localhost/workflows" },
    kind: null, issue: null, message, artifacts: [],
  };
  const slot = platform.prepare("INSERT INTO workflow_run_slots (runId, slot, value, complete, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)");
  for (const [key, value] of Object.entries(slots)) slot.run(run.id, key, JSON.stringify(value), run.at, run.at);

  if (lost || name === "interruptedDraft") ledger(platform, run, "completed", 200, null, 1);
  else if (name !== "missingUsage") ledger(platform, run, "aborted", null, "no_response", 1);
  if (name === "pending") ledger(platform, run, "streaming", null, null, 2);
  if (name === "mixed") ledger(platform, run, "completed", 200, null, 2);

}

export function seedPlan(app, input, installation, grants, run, fixture) {
  const { requestId, request, repositories, createIssue, kind, anchorRepository = null } = input;
  app.prepare(`INSERT INTO foundry_plans
    (key, requestId, runId, digest, repositoryGrants, repositories, anchorRepository, issuePublisherId,
      state, updatedAt, message, failureCode, failedAttempts, artifact)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?)`)
    .run(digest([run.orgId, installation.id, run.userId, requestId]), requestId, run.id,
      digest([request, repositories, anchorRepository, createIssue, kind]), JSON.stringify(grants),
      JSON.stringify(repositories), anchorRepository, fixture.issuePublisherId ?? null,
      run.at, fixture.message, fixture.failureCode ?? null, JSON.stringify(fixture.history ?? []),
      fixture.artifact ?? null);
}

export async function legacyContext({ box, platform, installation, input, invoke, missingRequestId }) {
  // An authenticated read starts and migrates the normal installed Worker.
  await assert.rejects(invoke("graph_query", "FoundryPlan", { input: { requestId: missingRequestId } }),
    /MCP FoundryPlan refused/);
  const member = platform.prepare(`SELECT u.id AS userId, i.organizationId AS orgId
    FROM user u JOIN app_installations i ON i.id = ? WHERE u.email = 'local@example.test'`).get(installation.id);
  assert.equal(member.orgId, "local-b0c50000-0000-4000-8000-000000000001");
  const grants = await Promise.all(input.repositories.map(async name => ({
    name, connectionId: "box-forgejo", repositoryId: (await admin(box, "GET", `/repos/${name}`)).id,
  })));
  const workflow = JSON.parse(readFileSync("/package/software-foundry.operational.json", "utf8")).manifest.workflows
    .find(item => item.definition.id === workflowId).definition;
  return { app: openFoundryDatabase(box, installation), member, grants, workflow, at: Date.now() - 120_000 };
}

export async function exerciseLegacy({ box, platform, installation, input, invoke, waitForProvider, report }) {
  const { app, member, grants, workflow, at } = await legacyContext({
    box, platform, installation, input, invoke, missingRequestId: cases.settled[0],
  });
  const oldHistory = { runId: cases.settled[1], message, failureCode: null, failedAt: at,
    workflowStatus: "complete", reasons: ["no_response"] };
  const payload = name => ({ ...input, requestId: cases[name][0] });
  const submit = name => invoke("graph_mutate", "PlanWork", { input: payload(name) });
  const checks = report.legacy = {};
  try {
    for (const [name, [, id]] of Object.entries(cases)) {
      const run = { ...member, id, at };
      const request = payload(name);
      seedWorkflow(platform, request, installation, workflow, run, name);
      const lost = name === "lostCollect";
      seedPlan(app, request, installation, grants, run, {
        message: lost ? typedMessage : message,
        ...(lost ? { failureCode: "no_structured_answer", history: [oldHistory] } : {}),
      });
    }
    const config = platform.prepare("SELECT config FROM connections WHERE id = 'box-forgejo'").get().config;
    const set = platform.prepare("UPDATE connections SET config = ? WHERE id = 'box-forgejo'");
    set.run(JSON.stringify({ ...JSON.parse(config), repositories: ["box/native-apple"] }));
    try {
      await assert.rejects(submit("deniedCoverage"), error => {
        assert.match(error.message, /MCP PlanWork refused/);
        assert.match(error.toolText, /Repository read unavailable: box\/charts/i);
        return true;
      });
      checks.deniedCoverage = true;
    } finally {
      set.run(config);
    }
    for (const name of ["missingUsage", "pending", "mixed", "missingReceipt", "contradictoryReceipt", "runningLegacy"]) {
      const denied = await submit(name);
      assert.equal(denied.status, "failed");
      assert.equal(denied.run.id, cases[name][1]);
      assert.deepEqual(denied.failedAttempts, []);
      checks[name] = true;
    }
    const lost = await submit("lostCollect");
    assert.equal(lost.failureCode, "no_structured_answer");
    assert.equal(lost.run.id, cases.lostCollect[1]);
    assert.equal(lost.failedAttempts[0].runId, oldHistory.runId);
    const repaired = platform.prepare("SELECT value, complete FROM workflow_run_slots WHERE runId = ? AND slot = ?")
      .get(lost.run.id, outputSlot);
    assert.equal(repaired.complete, 1);
    assert.equal(JSON.parse(repaired.value).failureCode, "no_structured_answer");
    assert.equal(platform.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(lost.run.id).status, "complete");
    checks.lostCollect = lost;
    assert.ok(!platform.prepare("SELECT 1 FROM workflow_runs WHERE createdAt > ?").get(at));

    const first = submit("settled").then(result => ({ result }), error => ({ error }));
    let overlapping;
    try {
      await waitForProvider("request");
      overlapping = await submit("settled");
      assert.equal(overlapping.status, "in_progress");
    } finally {
      writeFileSync(join(box.out, "release-provider"), "");
    }
    const outcome = await first;
    if (outcome.error) throw outcome.error;
    const result = outcome.result;
    assert.equal(result.status, "artifacts_only");
    assert.equal(overlapping.run.id, result.run.id);
    assert.notEqual(result.run.id, cases.settled[1]);
    assert.equal(result.failedAttempts.length, 1);
    assert.equal(result.failedAttempts[0].runId, cases.settled[1]);
    assert.equal(result.failedAttempts[0].actorAttribution, "member_only");
    assert.ok(result.failedAttempts[0].reasons.includes("no_response"));
    assert.equal(platform.prepare("SELECT count(*) AS count FROM workflow_runs WHERE createdAt > ?").get(at).count, 1);
    const replay = await submit("settled");
    assert.equal(replay.run.id, result.run.id);
    assert.deepEqual(replay.failedAttempts, result.failedAttempts);
    checks.settled = { overlapping, result };
    report.checks.legacyRecovery = true;
    return { result, requestId: cases.settled[0] };
  } finally {
    app.close();
  }
}

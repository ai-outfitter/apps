import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const checkoutProof = "Pinned checkout could not initialize.";
const fixtureEvidence = {
  attemptId: "00000000-0000-4000-8000-000000000002",
  artifactId: "00000000-0000-4000-8000-000000000003",
};
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function withFoundryDatabase(box, installation, exercise, readOnly = false) {
  const root = join(dirname(box.databases.platform), "apps", installation);
  for (const file of readdirSync(root, { recursive: true }).filter(name => name.endsWith(".sqlite"))) {
    const db = new DatabaseSync(join(root, file), { readOnly });
    try {
      db.exec("PRAGMA busy_timeout=5000");
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'foundry_forgejo_issue_reviews'").get()) {
        return exercise(db);
      }
    } finally {
      db.close();
    }
  }
  throw new Error("Disposable Foundry review database was not initialized");
}

export function reviewRows(box, installation) {
  return withFoundryDatabase(box, installation, db =>
    db.prepare("SELECT * FROM foundry_forgejo_issue_reviews ORDER BY runId").all(), true);
}

const insert = (db, table, record) => {
  const columns = Object.keys(record);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(record));
};

export function seedPriorReview(box, report, pin, workflowId, github) {
  const { id: installationId, organizationId, activeHash } = report.installation;
  const { manifest } = JSON.parse(readFileSync("/package/software-foundry.operational.json", "utf8"));
  const { definition } = manifest.workflows.find(item => item.definition.id === workflowId);
  const migrations = manifest.database.migrations;
  const recovery = migrations.findIndex(migration => migration.name === "0014_foundry_forgejo_issue_recovery");
  assert.ok(recovery > 0);
  const origin = github ? "https://github.com" : "http://127.0.0.1:3300";
  const { id, title, body, number } = report.before.issues[0];
  assert.ok(id);
  const hash = digest([workflowId, installationId, origin, pin.repositoryId, pin.issueNumber, ...(github ? ["github"] : [])]);
  const runId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const inputs = {
    "implement.inputs.target": { ...pin, origin, branch: `outfitter-review-${runId}`,
      workerId: github?.appId ?? report.actors.worker.id, reviewer: report.actors.reviewer.login,
      reviewerId: github?.reviewerId ?? report.actors.reviewer.id,
      ...(github ? { provider: "GITHUB", workerLogin: `${github.appSlug}[bot]`, githubInstallationId: github.githubInstallationId } : {}) },
    "implement.inputs.issue": { number, title, body, url: `${origin}/${pin.repository}/issues/${number}` },
    "implement.inputs.connectionId": github ? "github:user" : report.grant.connectionId,
    "implement.inputs.implementerBinding": report.bindings.implementer,
    "implement.inputs.reviewerBinding": report.bindings.reviewer,
  };
  const platform = new DatabaseSync(box.databases.platform);
  const oldDatabase = new DatabaseSync(":memory:");
  try {
    platform.exec("PRAGMA busy_timeout=5000");
    const { id: userId } = platform.prepare("SELECT id FROM user WHERE email = 'local@example.test'").get();
    assert.ok(userId);
    const prior = {
      runId, repositoryId: pin.repositoryId, forgeOrigin: origin, issueNumber: number,
      installationId, createdBy: userId, inputs: JSON.stringify(inputs),
    };
    for (const migration of migrations.slice(0, recovery)) oldDatabase.exec(migration.sql);
    insert(oldDatabase, "foundry_forgejo_issue_reviews", prior);
    const read = db => ({ ...db.prepare("SELECT * FROM foundry_forgejo_issue_reviews WHERE runId = ?").get(runId) });
    const before = read(oldDatabase);
    assert.ok(!Object.hasOwn(before, "recoveryOf"));
    oldDatabase.exec(migrations[recovery].sql);
    assert.deepEqual(read(oldDatabase), { ...before, recoveryOf: null });
    assert.throws(() => insert(oldDatabase, "foundry_forgejo_issue_reviews", { ...prior, runId: "duplicate" }),
      /UNIQUE constraint failed/);
    insert(oldDatabase, "foundry_forgejo_issue_reviews", { ...prior, runId: "child", recoveryOf: runId });
    assert.throws(() => insert(oldDatabase, "foundry_forgejo_issue_reviews", { ...prior, runId: "duplicate", recoveryOf: runId }),
      /UNIQUE constraint failed/);
    for (const migration of migrations.slice(recovery + 1)) oldDatabase.exec(migration.sql);
    const migrated = read(oldDatabase);
    assert.deepEqual(Object.fromEntries(Object.keys(before).map(key => [key, migrated[key]])), before);
    withFoundryDatabase(box, installationId, db => {
      insert(db, "foundry_forgejo_issue_reviews", before);
      assert.deepEqual(read(db), migrated, "The active installed worker reads the migrated legacy shape");
    });
    const { revision: bindingRevision } = platform.prepare("SELECT revision FROM workflow_executor_bindings WHERE id = ?")
      .get(report.bindings.implementer);
    const { attemptId, artifactId } = fixtureEvidence;
    const at = Date.now() - 120_000;
    const definitionHash = digest(definition);
    const settledAt = at + 1_000;
    platform.exec("BEGIN IMMEDIATE");
    try {
      insert(platform, "workflow_runs", {
        id: runId, workflowId, version: definition.version, definition: JSON.stringify(definition),
        definitionHash, createdBy: userId, organizationId, installationId,
        status: "failed", createdAt: at, updatedAt: settledAt,
      });
      for (const [slot, value] of Object.entries(inputs)) insert(platform, "workflow_run_slots", {
        runId, slot, value: JSON.stringify(value), complete: 1, createdAt: at, updatedAt: at,
      });
      insert(platform, "workflow_node_attempts", {
        id: attemptId, runId, nodeId: "implement", bindingId: report.bindings.implementer, bindingRevision,
        packageHash: activeHash, definitionHash, state: "failed", leaseId: "eaa834f9-1763-4f37-a07a-557e027c2061",
        receipt: JSON.stringify({ failure: { message: checkoutProof, sessionArtifact: { id: artifactId, runId } } }),
        expiresAt: settledAt, createdAt: at, updatedAt: settledAt,
      });
      platform.exec("COMMIT");
    } catch (error) {
      platform.exec("ROLLBACK");
      throw error;
    }
    return { runId, migration: { previous: migrations[recovery - 1].name, applied: migrations[recovery].name,
      originalRowPreserved: true, uniqueOriginalAndChild: true, recoveryOf: migrated.recoveryOf, cutoff: "rev2 failed pre-agent checkout" } };
  } finally {
    platform.close();
    oldDatabase.close();
  }
}

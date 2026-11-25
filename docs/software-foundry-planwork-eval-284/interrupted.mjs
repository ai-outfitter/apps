import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { legacyContext, seedPlan, seedWorkflow } from "./legacy.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/collection-cases.json", import.meta.url)));
const legacyFailure = "Foundry could not produce a verified plan from the selected evidence.";
const typedFailure = "Planning inference did not return a structured answer.";
const rejectedDraft = "The plan was saved, but its issue draft did not follow the anchor repository's issue template.";
const output = "plan.outputs.result";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function exerciseInterrupted({ box, platform, installation, input, invoke, report }) {
  const { app, member, grants, workflow, at } = await legacyContext({
    box, platform, installation, input, invoke, missingRequestId: fixtures.typed[0],
  });
  const { externalId: botId } = platform.prepare("SELECT externalId FROM connections WHERE id = 'box-forgejo'").get();
  const checks = report.interrupted = {};
  const slot = platform.prepare("SELECT value, complete, actorId, createdAt, updatedAt FROM workflow_run_slots WHERE runId = ? AND slot = ?");
  const runStatus = platform.prepare("SELECT status FROM workflow_runs WHERE id = ?");
  try {
    for (const [kind, [requestId, id, oldId]] of Object.entries(fixtures)) {
      const draft = kind === "draft";
      const request = { ...input, requestId, createIssue: draft, ...(draft ? { anchorRepository: "box/native-apple" } : {}) };
      const run = { ...member, id, at };
      let history;
      if (oldId) {
        seedWorkflow(platform, request, installation, workflow, { ...run, id: oldId }, "history");
        history = [{ runId: oldId, message: legacyFailure, failureCode: null, failedAt: at,
          workflowStatus: "complete", reasons: ["no_response"] }];
      }
      seedWorkflow(platform, request, installation, workflow, run, draft ? "interruptedDraft" : "lostCollect");
      const artifact = draft ? JSON.stringify({ version: 1, plan: { kind: "feature", title: "Rejected synthetic draft" } }) : undefined;
      seedPlan(app, request, installation, grants, run, draft
        ? { message: rejectedDraft, artifact, issuePublisherId: Number(botId) }
        : { message: typedFailure, failureCode: "no_structured_answer", history });

      // Read the exact app receipt through OAuth before injecting the split write.
      const before = await invoke("graph_query", "FoundryPlan", { input: { requestId } });
      const { plan, failedAttempts, failureCode, ...fields } = before;
      assert.equal(fields.status, "failed");
      assert.equal(fields.run.id, id);
      const stored = { ...(failureCode ? { failureCode } : {}), ...fields };
      if (kind === "divergent") stored.message = "A different synthetic receipt";
      platform.prepare(`INSERT INTO workflow_run_slots
        (runId, slot, value, complete, actorId, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run(id, output, JSON.stringify(stored), member.userId, at, at);
      const original = slot.get(id, output);
      assert.equal(runStatus.get(id).status, "running");

      const submit = () => invoke("graph_mutate", "PlanWork", { input: request });
      const replies = await Promise.all([submit(), submit()]);
      for (const reply of replies) {
        assert.equal(reply.status, "failed");
        assert.equal(reply.run.id, id);
        assert.deepEqual(reply.failedAttempts, failedAttempts);
        assert.deepEqual(reply.artifacts, before.artifacts);
        assert.equal(reply.issue, null);
      }
      const status = runStatus.get(id).status;
      assert.equal(status, kind === "divergent" ? "running" : "complete");
      assert.deepEqual(slot.get(id, output), original);
      if (draft) {
        assert.equal(before.artifacts.length, 1);
        assert.equal(before.artifacts[0].sha256, sha256(artifact));
      }
      checks[kind] = { requestId, runId: id, runStatus: status, slotSha256: sha256(original.value),
        slotUnchanged: true, history: failedAttempts, artifactSha256: before.artifacts[0]?.sha256 ?? null };
    }
    assert.equal(platform.prepare("SELECT count(*) AS count FROM workflow_runs WHERE createdAt > ?").get(at).count, 0);
    assert.ok(!existsSync(join(box.out, "mock-publications.json")));
    assert.ok(!existsSync(join(box.out, "provider.jsonl")));
    report.checks.interruptedCollection = true;
  } finally {
    app.close();
  }
}

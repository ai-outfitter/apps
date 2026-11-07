import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { identityHeaderValues } from "@ai-outfitter/app-sdk/server";
import {
  workflowHostPath,
  type WorkflowHostScope,
} from "@ai-outfitter/app-sdk/workflow-host";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";

test("review schedule requires editor identity and uses its reserved run", async (t) => {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const worker = await appWorker(
    "wiki-map",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "wiki",
    {
      workflowHost: () => ({
        call: async (operation, input) => {
          const value = input as Record<string, unknown>;
          calls.push({ operation, input: value });
          if (operation === "workflow.start")
            return {
              ok: true,
              value: { id: value.id, workflow: value.workflow, created: true },
            };
          if (operation === "session.append") return { ok: true, value: { id: "review" } };
          if (operation === "inference.generate")
            return {
              ok: true,
              value: { output: { summary: "Reviewed", findings: [] } },
            };
          if (operation === "workflow.collect")
            return {
              ok: true,
              value: { run: "complete", steps: { review: "complete" } },
            };
          return { ok: false, status: 503, message: "Unavailable" };
        },
      }),
    },
  );
  t.after(() => worker.dispose());
  const batch = "72000000-0000-4000-8000-000000000901",
    job = "72000000-0000-4000-8000-000000000902";
  const digest = createHash("sha256").update("[]").digest("hex");
  await worker.database
    .prepare(
      "INSERT INTO graph_batches(id,title,policy,state,openedBy,openedVia,createdAt,updatedAt,expiresAt,reviewJobId) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      batch,
      "Review",
      '{"kind":"member"}',
      "awaiting_review",
      "owner",
      '{"kind":"member","id":"owner"}',
      1,
      1,
      Date.now() + 60_000,
      job,
    )
    .run();
  await worker.database
    .prepare(
      "INSERT INTO onto_review_jobs(id,batchId,contentDigest,state,nextAttemptAt,createdAt) VALUES(?,?,?,?,?,?)",
    )
    .bind(job, batch, digest, "pending", 1, 1)
    .run();
  const runId = "b10351d9-3485-4b63-9fe9-1ce2b5c37f87";
  const body = {
    phase: "schedule",
    input: {
      runId,
      scheduledFor: 1,
      schedule: {
        id: "s",
        workflowId: "batch-review",
        inputs: {},
        connectionId: null,
        resource: null,
      },
    },
  };
  const scope: WorkflowHostScope = {
    organizationId: "org",
    installationId: "wiki",
    userId: "owner",
    packageHash: "hash",
    phase: "schedule",
    scheduleId: "s",
    expiresAt: Date.now() + 60_000,
  };
  const dispatch = (role: string) =>
    worker.dispatch(
      "",
      new Request(`${worker.origin}${workflowHostPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...identityHeaderValues({
            userId: "owner",
            organizationId: "org",
            installationId: "wiki",
            role,
          }),
        },
        body: JSON.stringify(body),
      }),
      { workflowHost: scope },
    );
  const denied = await dispatch("member");
  assert.equal(
    ((await denied.json()) as { outcome: string }).outcome,
    "declined",
  );
  assert.equal(calls.filter((c) => c.operation === "workflow.start").length, 0);
  const accepted = await dispatch("owner");
  assert.equal(
    ((await accepted.json()) as { outcome: string }).outcome,
    "started",
  );
  const start = calls.find((c) => c.operation === "workflow.start");
  assert.equal(start?.input.workflow, "batch-review");
  assert.equal(start?.input.id, runId);
});

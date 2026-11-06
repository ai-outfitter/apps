import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowRun } from "@ai-outfitter/app-sdk/workflows";
import { runNodes } from "../src/features/workflows/nodes";
import { Workflow as workflowSchema } from "@ai-outfitter/workflow-core/schema";

test("run nodes preserve pinned historical definitions and isolate each node evidence", () => {
  const run = {
    id: "run",
    createdAt: 0,
    updatedAt: 0,
    createdBy: "user",
    organizationId: "org",
    installationId: "installation",
    status: "running",
    attempts: [
      {
        nodeId: "review",
        state: "uncertain",
        createdAt: 1,
        updatedAt: 2,
        expiresAt: 10,
      },
      {
        nodeId: "review-again",
        state: "running",
        createdAt: 3,
        updatedAt: 4,
        expiresAt: 10,
      },
    ],
    inputs: {},
    workflow: workflowSchema.parse({
      id: "old-definition",
      version: "beta",
      summary: "Historical review",
      actors: { reviewer: { kind: "resident" } },
      steps: [
        {
          id: "review",
          actor: "reviewer",
          instructions: "Original pinned review",
          outputs: { review: { schema: { type: "object" } } },
        },
        {
          id: "review-again",
          actor: "reviewer",
          instructions: "Second review",
          outputs: { review: { schema: { type: "string" } } },
        },
      ],
    }),
    steps: { review: "blocked" },
    rows: {
      "review.outputs.review": {
        value: { decision: "blocked" },
        complete: false,
      },
      "review-again.outputs.review": { value: "other", complete: false },
    },
  } satisfies WorkflowRun;
  const nodes = runNodes(run);
  assert.equal(nodes[0].instructions, "Original pinned review");
  assert.equal(nodes[0].status, "blocked");
  assert.deepEqual(Object.keys(nodes[0].evidence), ["review.outputs.review"]);
  assert.equal(nodes[1].status, "waiting");
  assert.deepEqual(
    nodes[0].attempts.map((attempt) => attempt.state),
    ["uncertain"],
  );
  assert.deepEqual(
    nodes[1].attempts.map((attempt) => attempt.state),
    ["running"],
  );
});

test("native output evidence presents scoped images and formal receipts while rejecting unsafe or foreign sources", async () => {
  const { nodeEvidence } = await import("../src/features/workflows/evidence");
  const run = { id: "run", installationId: "app", inputs: {} } as WorkflowRun;
  const image = {
    runId: "run",
    installationId: "app",
    nodeId: "implement",
    filename: "desktop.png",
    headSha: "a".repeat(40),
    sha256: "b".repeat(64),
    url: `https://software-foundry.outfitter.ai-outfitter.com/files/main/runs/run/demo-${"a".repeat(40)}-${"b".repeat(16)}-desktop.png`,
  };
  const result = {
    candidate: {
      url: "https://github.com/org/repo/pull/1",
      headSha: image.headSha,
    },
    review: {
      url: "https://github.com/org/repo/pull/1#pullrequestreview-2",
      verdict: "approved",
    },
    sessionArtifact: {
      id: "00000000-0000-4000-8000-000000000002",
      runId: "run",
    },
    checks: [
      {
        name: "test",
        passed: true,
        url: "https://github.com/org/repo/actions/runs/3",
      },
    ],
    evidence: [image],
    demo: { status: "needs-attention", missing: ["mobile"] },
  };
  const rows = {
    "implement.outputs.result": { complete: true, value: result },
  };
  const view = nodeEvidence(run, "implement", rows);
  assert.equal(view.links.length, 4);
  assert.equal(
    view.links.find((link) => link.label === "Download private session archive")
      ?.url,
    "/api/platform/artifacts/00000000-0000-4000-8000-000000000002?download=1",
  );
  assert.deepEqual(view.images, [
    {
      filename: image.filename,
      url: image.url,
      headSha: image.headSha,
      sha256: image.sha256,
    },
  ]);
  assert.deepEqual(view.notices, ["Demo needs review: mobile"]);
  for (const changed of [
    { installationId: "foreign" },
    { runId: "foreign" },
    { nodeId: "review" },
    { headSha: "c".repeat(40) },
    { url: "https://foreign.example/image.png" },
    { filename: "mobile.png" },
    { url: "javascript:alert(1)" },
  ]) {
    assert.deepEqual(
      nodeEvidence(run, "implement", {
        "implement.outputs.result": {
          complete: true,
          value: { ...result, evidence: [{ ...image, ...changed }] },
        },
      }).images,
      [],
    );
  }
  assert.deepEqual(
    nodeEvidence(run, "implement", {
      "implement.outputs.result": {
        complete: true,
        value: { candidate: { url: "javascript:alert(1)" } },
      },
    }).links,
    [],
  );
});

test("private archives remain visible when a node stopped before producing outputs",async()=>{
 const {nodeEvidence}=await import("../src/features/workflows/evidence");
 const run={id:"run",installationId:"app",inputs:{},attempts:[{nodeId:"implement",state:"failed",sessionArtifact:{id:"00000000-0000-4000-8000-000000000002",runId:"run"}}]} as WorkflowRun;
 const view=nodeEvidence(run,"implement",{});
 assert.ok(view.links.some(link=>link.url.endsWith("?download=1")));
 assert.equal(nodeEvidence(run,"review",{}).links.length,0);
});

test("per-installation storage receipts need no legacy image or node fields", async () => {
 const {nodeEvidence}=await import("../src/features/workflows/evidence");
 const headSha="a".repeat(40), sha256="b".repeat(64);
 const run={id:"run",installationId:"app",inputs:{},attempts:[]} as unknown as WorkflowRun;
 const evidence={runId:"run",filename:"desktop.png",headSha,sha256,url:`https://software-foundry.outfitter.ai-outfitter.com/files/main/runs/run/demo-${headSha}-${sha256.slice(0,16)}-desktop.png`};
 assert.equal(nodeEvidence(run,"implement",{"implement.outputs.result":{complete:true,value:{candidate:{headSha},evidence:[evidence]}}}).images.length,1);
});

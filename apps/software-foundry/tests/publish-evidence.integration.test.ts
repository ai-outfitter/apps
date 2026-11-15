import assert from "node:assert/strict";
import test from "node:test";
import { actionPath } from "@ai-outfitter/app-sdk/actions";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import standard from "@ai-outfitter/app-sdk/graph/standard-types.json" with { type: "json" };
import { documents } from "../src/server/documents";

// The front door from uploaded evidence to Planning (gap 1 in webapp
// docs/plans/evidence-to-planning.md): PublishEvidence names the bundle, the
// Planning project and its screenshots; Foundry stages the records Planning's
// Evidence page reads as one Onto batch and submits it for a member's review.
// Onto is a host double that records the StageChanges and SubmitBatch it receives.

const who = { userId: "editor", organizationId: "org", role: "owner" };
const scope = { ...who, installationId: "foundry", packageHash: "fixture", phase: "interactive" as const, expiresAt: Date.now() + 600_000 };
const planningProject = "6f2c1a9e-0d1b-4c51-9a77-2b7e5f0c1a01";
const projectNode = "4731d6de-bcb0-42b2-a968-5b79b2422d6f";
const stamp = { revision: 1, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null, archived: false };
const types = (standard as { id: string; name: string; category: string }[])
  .filter((type) => ["Project", "Product", "Document", "Demonstration", "documents"].includes(type.name))
  .map((type) => ({ ...stamp, id: type.id, name: type.name, title: type.name, category: type.category, body: "", properties: [], seedVersion: null }));
const graph = {
  version: 1, installationId: "onto", types, edges: [], selection: null, truncated: false, missingTypes: [],
  nodes: [{ ...stamp, id: projectNode, typeId: types.find((type) => type.name === "Project")!.id, title: "Fernlight iOS app", summary: "", body: "", website: null, properties: {}, source: { installationId: "planning", type: "project", id: planningProject } }],
};
const provider = (installationId: string, type: string, hostname: string) =>
  ({ installationId, type, title: type, description: "", schema: {}, writable: true, hostname });

function onto(staged: unknown[], submitted: unknown[]) {
  return () => ({
    async call(operation: string, raw: unknown) {
      const input = raw as { template?: string; installationId?: string; action?: string; input?: { operationName?: string; variables?: { input: Record<string, unknown> } } };
      if (operation === "entities.types") {
        if (input.template === "onto") return { ok: true, value: ["graph-type", "graph-node", "graph-edge"].map((type) => provider("onto", type, "onto.org.example")) };
        if (input.installationId === "planning") return { ok: true, value: [provider("planning", "project", "planning.org.example")] };
        return { ok: true, value: [] };
      }
      if (operation !== "actions.call") return { ok: false, status: 403, message: `Not in this fixture: ${operation}` };
      if (input.action === "graph.read") return { ok: true, value: graph };
      const name = input.input?.operationName;
      const variables = input.input!.variables!.input;
      if (name === "StageChanges") {
        staged.push(variables);
        return { ok: true, value: { data: { stageChanges: { id: "9b8f1c62-3c1e-4d1e-9c55-0d0a1e0b0001", state: "open", counts: {} } } } };
      }
      if (name === "SubmitBatch") {
        submitted.push(variables);
        return { ok: true, value: { data: { submitBatch: { id: variables.batchId, state: "awaiting_review", counts: {} } } } };
      }
      return { ok: false, status: 404, message: `Unknown action ${input.action}` };
    },
  });
}

const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0dc5a6b70000000049454e44ae426082", "hex");
const paths = ["office.png", "unconfirmed.png"];
const input = (overrides: Record<string, unknown> = {}) => ({
  bundle: "fernlight-ios-run",
  projectId: planningProject,
  title: "iOS happy path",
  body: "**Result:** 1 passed; 0 failed; 0 skipped.\n\nSimulator and fixture API only; checkout is mocked.",
  environment: "iPhone simulator, fixture API",
  capturedAt: "2026-11-14T05:26:59Z",
  limitations: ["Simulator only."],
  steps: [{ title: "Office collection", path: paths[0] }, { title: "Unconfirmed plant", path: paths[1], caption: "Before confirming" }],
  ...overrides,
});

test("PublishEvidence stages the bundle for review on the Planning project and a repeat reads the same batch", async () => {
  const staged: any[] = [], submitted: any[] = [];
  const app = await appWorker("software-foundry", appArtifact(new URL("..", import.meta.url), "operational"), "foundry", { workflowHost: onto(staged, submitted) } as never);
  try {
    const call = async (action: string, body: unknown) => {
      const response = await app.call(`${actionPath}/call`, who, { method: "POST", body: { action, input: body }, workflowHost: scope } as never);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<any>;
    };
    const publish = (variables: unknown) => call("graph.mutate", { query: documentText(documents.PublishEvidence.document), variables: { input: variables } });

    // Before upload: refused, naming the step that comes first.
    const early = await publish(input());
    assert.match(early.errors?.[0]?.message ?? "", /not uploaded; publish it with SubmitReleaseEvidence first/);

    for (const path of paths)
      await call("evidence.publish", { bundle: "fernlight-ios-run", path, contentType: "image/png", sha256: await sha256Hex(png), base64: png.toString("base64") });

    const { data, errors } = await publish(input());
    assert.equal(errors, undefined, JSON.stringify(errors));
    const result = data.publishEvidence;
    assert.equal(result.state, "awaiting_review");
    assert.equal(result.reviewUrl, `https://onto.org.example/changes/${result.batchId}`);
    assert.equal(result.planningUrl, `https://planning.org.example/projects/${planningProject}/evidence?bundle=${result.documentId}`);
    assert.match(result.next, /Do not approve it yourself/);

    assert.equal(staged.length, 1);
    assert.deepEqual(staged[0].anchors, [projectNode]);
    const operations = staged[0].proposals.map((proposal: any) => proposal.operation);
    const document = operations.find((op: any) => op.ref === "$evidence-bundle").attributes;
    assert.match(document.body, /1 passed/);
    // Where it ran and what it does not show are always in the Document a member reads.
    assert.match(document.body, /## Where it ran and its limits\n\n- Environment: iPhone simulator, fixture API\n- Simulator only\./);
    const shots = operations.filter((op: any) => op.ref.startsWith("$evidence-step-"));
    assert.deepEqual(shots.map((op: any) => op.attributes.title), ["1. Office collection", "2. Unconfirmed plant"]);
    assert.deepEqual(shots.map((op: any) => JSON.parse(op.attributes.body).media[0].replace(/^.*\/files\//, "")), paths.map((path) => `main/evidence/fernlight-ios-run/${path}`));
    // Sunny-like graph without includes_record: the type arrives in the same batch.
    assert.equal(operations[0].ref, "$includes-record-type");
    assert.equal(operations.at(-1).attributes.toId, projectNode);
    assert.deepEqual(submitted.map((item) => item.batchId), [result.batchId]);

    // A retry (say, after a lost response) reads the same batch and stages nothing new.
    const again = await publish(input());
    assert.equal(again.data.publishEvidence.batchId, result.batchId);
    assert.equal(staged.length, 1);
    // The same bundle with other content is refused.
    const changed = await publish(input({ title: "Another run" }));
    assert.match(changed.errors?.[0]?.message ?? "", /already published with different content/);
  } finally {
    await app.dispose();
  }
});

test("PublishEvidence refuses a project Planning cannot show evidence on", async () => {
  const app = await appWorker("software-foundry", appArtifact(new URL("..", import.meta.url), "operational"), "foundry", { workflowHost: onto([], []) } as never);
  try {
    const call = async (action: string, body: unknown) =>
      (await app.call(`${actionPath}/call`, who, { method: "POST", body: { action, input: body }, workflowHost: scope } as never)).json() as Promise<any>;
    for (const path of paths)
      await call("evidence.publish", { bundle: "fernlight-ios-run", path, contentType: "image/png", sha256: await sha256Hex(png), base64: png.toString("base64") });
    const result = await call("graph.mutate", { query: documentText(documents.PublishEvidence.document), variables: { input: input({ projectId: "0d9c3b1a-8e7f-4a6b-9c5d-4e3f2a1b0c9d" }) } });
    assert.match(result.errors?.[0]?.message ?? "", /No Onto Project references Planning project/);
  } finally {
    await app.dispose();
  }
});

test("PublishEvidence takes the receipt's file URLs and dates the run from the upload when no capture time is given", async () => {
  const staged: any[] = [];
  const app = await appWorker("software-foundry", appArtifact(new URL("..", import.meta.url), "operational"), "foundry", { workflowHost: onto(staged, []) } as never);
  try {
    const call = async (action: string, body: unknown) =>
      (await app.call(`${actionPath}/call`, who, { method: "POST", body: { action, input: body }, workflowHost: scope } as never)).json() as Promise<any>;
    const urls: string[] = [];
    for (const path of paths)
      urls.push((await call("evidence.publish", { bundle: "fernlight-ios-run", path, contentType: "image/png", sha256: await sha256Hex(png), base64: png.toString("base64") })).url);
    const { capturedAt: _omitted, ...rest } = input();
    const result = await call("graph.mutate", { query: documentText(documents.PublishEvidence.document), variables: { input: { ...rest, steps: urls.map((url, i) => ({ title: `Step ${i + 1}`, path: url })) } } });
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    const shots = staged[0].proposals.map((p: any) => p.operation).filter((op: any) => op.ref.startsWith("$evidence-step-")).map((op: any) => JSON.parse(op.attributes.body));
    assert.deepEqual(shots.map((body: any) => body.media[0]), urls);
    assert.ok(Math.abs(Date.parse(shots[0].capturedAt) - Date.now()) < 60_000, shots[0].capturedAt);
    const foreign = await call("graph.mutate", { query: documentText(documents.PublishEvidence.document), variables: { input: { ...input({ bundle: "other-run" }), steps: [{ title: "Office", path: urls[0] }] } } });
    assert.match(foreign.errors?.[0]?.message ?? "", /is not a file of bundle other-run/);
  } finally {
    await app.dispose();
  }
});

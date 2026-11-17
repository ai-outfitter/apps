import assert from "node:assert/strict";
import { test } from "node:test";
import { queryGraph } from "@ai-outfitter/app-sdk/graph-query";
import {
  submitVisualEvidence,
  readVisualEvidence,
} from "../src/server/visual-evidence";
import { capture } from "./fixtures/visual-evidence";
import {
  projectReleasesFixture,
  releaseProviders,
  releaseId,
} from "./fixtures/project-releases";
function setup() {
  const graph = projectReleasesFixture();
  graph.types.push(
    { ...graph.types[0], id: releaseId(120), name: "ProductRevision" },
    { ...graph.types[4], id: releaseId(121), name: "produces" },
  );
  graph.nodes.push({
    ...graph.nodes[0],
    id: capture.productRevision.id,
    typeId: releaseId(120),
    source: null,
  });
  graph.edges.push({
    ...graph.edges[0],
    id: releaseId(122),
    typeId: releaseId(121),
    fromId: releaseId(1),
    toId: capture.productRevision.id,
  });
  const staged: any[] = [];
  let writes = 0;
  const host = {
    async call(op: string, input: any) {
      if (op === "entities.types") return releaseProviders();
      if (op === "actions.call") {
        if (input.action === "graph.query")
          return queryGraph(
            {
              version: 1,
              installationId: "wiki",
              ...graph,
              selection: null,
              truncated: false,
              missingTypes: [],
            } as never,
            input.input,
          );
        if (input.action === "batch.get")
          return { batch: { state: "open" }, operations: staged };
        if (input.action === "batch.add") {
          writes++;
          staged.push(...input.input.proposals);
          return {};
        }
      }
      throw Error(op + ":" + input.action);
    },
  };
  const context: any = {
    identity: { installationId: "planning", userId: "owner", canEdit: true },
    host: () => host,
    db: () => ({
      select: () => ({
        from: () => ({
          where: async () => [{ id: capture.project.id, revision: 1 }],
        }),
      }),
    }),
  };
  return { context, graph, staged, writes: () => writes };
}
test("repeat capture staging is idempotent and never submits or approves the graph batch", async () => {
  const s = setup(),
    input = { key: "demo-v1", batchId: releaseId(200), bundle: capture };
  const first = await submitVisualEvidence(s.context, input);
  const second = await submitVisualEvidence(s.context, input);
  assert.equal(first.id, second.id);
  assert.equal(s.writes(), 1);
  assert.equal(s.staged.length, 3);
  assert.equal(first.state, "staged");
  await assert.rejects(
    submitVisualEvidence(s.context, {
      ...input,
      bundle: { ...capture, summary: "changed" },
    }),
    (e) => e instanceof Response && e.status === 409,
  );
});
test("stale references, foreign project revision and read-only callers cannot stage evidence", async () => {
  const input = { key: "demo", batchId: releaseId(200), bundle: capture };
  let s = setup();
  await assert.rejects(
    submitVisualEvidence(s.context, {
      ...input,
      bundle: { ...capture, project: { ...capture.project, revision: 2 } },
    }),
    (e) => e instanceof Response && e.status === 409,
  );
  assert.equal(s.writes(), 0);
  s = setup();
  s.graph.edges = s.graph.edges.filter((e) => e.typeId !== releaseId(121));
  await assert.rejects(
    submitVisualEvidence(s.context, input),
    (e) => e instanceof Response && e.status === 409,
  );
  assert.equal(s.writes(), 0);
  s = setup();
  s.context.identity.canEdit = false;
  await assert.rejects(submitVisualEvidence(s.context, input));
  assert.equal(s.writes(), 0);
});

test("pending previews are explicit and cannot be read through another project", async () => {
  const s = setup(),
    batchId = releaseId(200);
  const staged = await submitVisualEvidence(s.context, {
    key: "preview",
    batchId,
    bundle: capture,
  });
  const result = await readVisualEvidence(s.context, {
    projectId: capture.project.id,
    bundleId: staged.id,
    batchId,
  });
  assert.equal(result.state, "open");
  assert.equal(result.bundle?.revision, 0);
  await assert.rejects(
    readVisualEvidence(s.context, {
      projectId: releaseId(300),
      bundleId: staged.id,
      batchId,
    }),
    (e) => e instanceof Response && e.status === 404,
  );
});

test("two captures in one batch have distinct relationship refs", async () => {
  const s = setup(),
    batchId = releaseId(200);
  await submitVisualEvidence(s.context, {
    key: "first",
    batchId,
    bundle: capture,
  });
  await submitVisualEvidence(s.context, {
    key: "second",
    batchId,
    bundle: capture,
  });
  assert.equal(new Set(s.staged.map((p) => p.operation.ref)).size, 6);
  s.staged[0].state = "committed";
  await assert.rejects(
    readVisualEvidence(s.context, {
      projectId: capture.project.id,
      bundleId: s.staged[0].operation.attributes.id,
      batchId,
    }),
    (e) => e instanceof Response && e.status === 404,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { appWorker } from "./fixtures/initialized-worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { importArtera } from "@ai-outfitter/creative-workflow/import";
import { digest } from "@ai-outfitter/creative-workflow";
import { typeIds } from "@ai-outfitter/creative-workflow";
const owner = { userId: "owner", organizationId: "artera", role: "owner" };
const id = (n: number) =>
  `cce00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test("shared graph freezes dependencies, reviews writes, reports stale candidates and preserves explicit selections", async (t) => {
  const app = await appWorker(
    "onto",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "creative-onto",
  );
  t.after(() => app.dispose());
  const call = async (action: string, input: any, identity: any = owner) => {
    const response = await app.call("/api/internal/actions/v1/call", identity, {
      method: "POST",
      body: { action, input },
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<any>;
  };
  const graph = async (query: string, variables: any = {}) =>
    call(query.startsWith("mutation") ? "graph.mutate" : "graph.graphql", {
      query,
      variables,
    });
  const pin = (n: number) => ({
    installationId: app.installationId,
    type: "graph-node",
    id: id(n),
    revision: 1,
  });
  await call("graph.apply", {
    requestKey: "subject",
    operations: [
      {
        operation: "create",
        ref: "$subject",
        type: "graph-node",
        attributes: {
          id: id(1),
          typeId: "71000000-0000-4000-8000-000000000012",
          title: "Spacecraft description",
          body: "Research concept",
        },
      },
    ],
  });
  const stage = async (n: number, kind: string, body: any, revision = 0) => {
    const result = await graph(
      "mutation($input:StageCreativeRecordInput!){stageCreativeRecord(input:$input)}",
      {
        input: {
          id: id(n),
          revision,
          kind,
          title: kind,
          body,
          subjectId: id(1),
        },
      },
    );
    assert.ok(!result.errors, JSON.stringify(result));
    return result.data.stageCreativeRecord;
  };
  const commit = async (batchId: string) => {
    await call("batch.submit", { batchId });
    const response = await app.call("/api/apps/onto/batches/review", owner, {
      method: "POST",
      body: { batchId, verdict: "approve" },
    });
    assert.equal(response.status, 200, await response.text());
  };
  const fragment = await stage(2, "PromptFragment", {
    id: id(2),
    revision: 1,
    text: "A spacecraft growing food",
    references: [],
  });
  let records = await graph("{creativeRecords(limit:50)}");
  assert.equal(records.data.creativeRecords.items.length, 0);
  await commit(fragment.batchId);
  const frozen = await graph(
    "mutation($input:FreezeCreativeInputsInput!){freezeCreativeInputs(input:$input)}",
    {
      input: {
        id: id(3),
        rootId: id(2),
        subjectId: id(1),
        title: "Frozen illustration",
        settings: { model: "fixture" },
      },
    },
  );
  assert.ok(!frozen.errors, JSON.stringify(frozen));
  await commit(frozen.data.freezeCreativeInputs.batchId);
  const candidate = await stage(4, "CreativeCandidate", {
    subject: pin(1),
    snapshot: pin(3),
    artifact: {
      provider: "repository",
      recordId: "render.png",
      contentHash: "a".repeat(64),
    },
    owner: { installationId: "presentations", type: "artifact", id: "render" },
    concept: true,
  });
  await commit(candidate.batchId);
  const selected = await stage(5, "CreativeSelection", {
    use: pin(1),
    slot: "design-reference",
    candidate: pin(4),
  });
  await commit(selected.batchId);
  records = await graph("{creativeRecords(limit:50)}");
  assert.equal(
    records.data.creativeRecords.items.find((n: any) => n.id === id(4)).drift
      .state,
    "current",
  );
  const changed = await stage(
    2,
    "PromptFragment",
    {
      id: id(2),
      revision: 2,
      text: "A spacecraft growing leafy greens",
      references: [],
    },
    1,
  );
  await commit(changed.batchId);
  records = await graph("{creativeRecords(limit:50)}");
  const items = records.data.creativeRecords.items;
  assert.equal(items.find((n: any) => n.id === id(4)).drift.state, "stale");
  assert.deepEqual(items.find((n: any) => n.id === id(4)).drift.changed, [
    id(2),
  ]);
  assert.equal(
    items.find((n: any) => n.typeId === typeIds.CreativeSelection).body
      .candidate.id,
    id(4),
  );
  assert.match(
    items.find((n: any) => n.id === id(3)).body.text,
    /growing food/,
  );
  const stale = await graph(
    "mutation($input:StageCreativeRecordInput!){stageCreativeRecord(input:$input)}",
    {
      input: {
        id: id(2),
        revision: 1,
        kind: "PromptFragment",
        title: "stale",
        body: { id: id(2), revision: 1, text: "overwrite", references: [] },
        subjectId: id(1),
      },
    },
  );
  assert.ok(stale.errors);
  const snapshot = items.find((n: any) => n.id === id(3));
  const immutable = await graph(
    "mutation($input:StageCreativeRecordInput!){stageCreativeRecord(input:$input)}",
    {
      input: {
        id: id(3),
        revision: 1,
        kind: "GenerationSnapshot",
        title: "replace",
        body: snapshot.body,
        subjectId: id(1),
      },
    },
  );
  assert.ok(immutable.errors);
  const addressed = await graph(
    "mutation($input:StageCreativeRecordAtAddressInput!){stageCreativeRecordAtAddress(input:$input)}",
    {
      input: {
        address: "CreativeBrief:artera-launch",
        revision: 0,
        kind: "CreativeBrief",
        title: "Artera launch",
        subject: "Document:spacecraft-description",
        body: {
          subject: { ...pin(1), id: "Document:spacecraft-description" },
          purpose: "Show the growth module",
          audience: "Researchers",
        },
      },
    },
  );
  assert.ok(!addressed.errors, JSON.stringify(addressed));
  await commit(addressed.data.stageCreativeRecordAtAddress.batchId);
  const views = await graph("{creativeRecordViews(limit:50)}");
  assert.equal(
    views.data.creativeRecordViews.items.find(
      (r: any) => r.address === "CreativeBrief:artera-launch",
    ).bodyView.subject.id,
    "Document:spacecraft-description",
  );
  const feedbackRecord = await stage(8, "CreativeFeedback", {
    candidate: pin(4),
    at: "2026-11-14T00:00:00Z",
    author: "reviewer",
    text: "Keep the selected shape",
  });
  await commit(feedbackRecord.batchId);
  const bypass = await app.call("/api/internal/actions/v1/call", owner, {
    method: "POST",
    body: {
      action: "graph.apply",
      input: {
        requestKey: "cannot-rewrite-frozen-inputs",
        operations: [
          {
            operation: "update",
            ref: "$snapshot",
            type: "graph-node",
            id: id(3),
            revision: 1,
            attributes: { title: "Changed snapshot" },
          },
        ],
      },
    },
  });
  assert.equal(bypass.status, 409);
  const external = await app.call(
    "/api/internal/actions/v1/call",
    { userId: "other", organizationId: "other", role: "external" },
    {
      method: "POST",
      body: { action: "graph.graphql", input: { query: "{creativeRecords}" } },
    },
  );
  if (external.status === 200)
    assert.ok(((await external.json()) as any).errors);
  else assert.ok([401, 403].includes(external.status));
  const opened = await call("batch.open", {
    title: "Artera import",
    purpose: "Import source fixtures",
    anchors: [id(1)],
    policy: { kind: "member" },
  });
  const rawImport = {
    format: "artera-creative-import/1",
    source: { deck: "fixture-deck" },
    files: { "prompts/IMG-01.md": "Imported spacecraft direction" },
    candidates: [
      {
        source: { image: "old.png" },
        snapshot: null,
        artifact: { sha256: "b".repeat(64) },
      },
    ],
    feedback: [],
    selections: [],
  };
  const manifest = {
    ...rawImport,
    hash: await digest(JSON.stringify(rawImport)),
  };
  const importOptions = {
    installationId: app.installationId,
    subject: {
      id: id(1),
      revision: 1,
      address: "Document:spacecraft-description",
    },
    owner: {
      installationId: "presentations",
      type: "repository",
      id: "artera",
    },
    batchId: opened.batch.id,
    read: async (recordId: string) => {
      const data = await graph("{creativeRecords(limit:50)}");
      const record = data.data.creativeRecords.items.find(
        (n: any) => n.id === recordId,
      );
      return record ? { revision: record.revision, body: record.body } : null;
    },
    stage: async (input: any) => {
      const data = await graph(
        "mutation($input:StageCreativeRecordAtAddressInput!){stageCreativeRecordAtAddress(input:$input)}",
        { input },
      );
      assert.ok(!data.errors, JSON.stringify(data));
      return data.data.stageCreativeRecordAtAddress;
    },
    artifact: async (row: any) => ({
      provider: "repository",
      recordId: row.source.image,
      contentHash: row.artifact.sha256,
    }),
  };
  await importArtera(manifest, importOptions);
  await commit(opened.batch.id);
  assert.equal(
    (await importArtera(manifest, importOptions)).receipts.length,
    0,
  );
  const anonymous = await app.call("/api/internal/actions/v1/call", undefined, {
    method: "POST",
    body: { action: "graph.graphql", input: { query: "{creativeRecords}" } },
  });
  assert.notEqual(anonymous.status, 200);
});

import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { ontoClient, ontoDocumentsClient } from "../src/client";
import { documentOperations } from "../src/contracts";
const provider = {
  version: 1 as const,
  installationId: "explicit-onto",
  contracts: [{ id: "outfitter.onto", version: 1 }],
  capabilities: ["graphql.read"],
  types: [],
  queryAction: "graph.graphql" as const,
};
const digest = "a".repeat(64);
const capture = {
  complete: true,
  errors: [],
  sources: [
    {
      provider: "source",
      config: "{}",
      provenance: { record: "synthetic" },
      snapshot: { title: "Evidence" },
      observedAt: "2026-11-07T00:00:00Z",
    },
  ],
};
const inputs = {
  define: {
    id: "definition",
    version: 1,
    definition: {
      sources: [{ provider: "forked-source", config: { selection: "work" } }],
    },
  },
  create: { id: "doc", definitionId: "definition", version: 1 },
  live: { id: "doc" },
  generate: { id: "doc", jobId: "job" },
  revision: { id: "doc", revision: 1 },
  job: { id: "job" },
  retry: { id: "job" },
  seal: { id: "doc", revision: 1, digest },
  policy: { id: "doc", revision: 1, action: "publish" },
};
const outputs = {
  define: { saved: true },
  create: { created: true },
  live: capture,
  generate: { queued: true, jobId: "job" },
  revision: {
    revision: 1,
    digest,
    payload: { document: { title: "Report", markdown: "Evidence" } },
    capture,
    complete: true,
    definitionId: "definition",
    definitionVersion: 1,
  },
  job: {
    id: "job",
    documentId: "doc",
    state: "retry",
    attempts: 1,
    error: "Source unavailable",
    baseRevision: 0,
  },
  retry: { queued: true },
  seal: { sealed: true, revision: 1, digest, approval: "not_requested" },
  policy: {
    decision: "require-review",
    binding: { documentId: "doc", revision: 1, digest },
  },
};
test("typed document client dispatches all operations to its fixed explicit provider", async () => {
  const calls: any[] = [];
  const host = {
    call: async (name: string, input: any) => {
      calls.push({ name, input });
      const key = Object.keys(documentOperations).find(
        (key) =>
          documentOperations[key as keyof typeof documentOperations].action ===
          input.action,
      )!;
      return outputs[key as keyof typeof outputs];
    },
  } as unknown as WorkflowHost<"interactive">;
  const mutable = { ...provider };
  const client = ontoDocumentsClient(host, mutable);
  mutable.installationId = "retargeted";
  for (const name of Object.keys(inputs) as Array<keyof typeof inputs>) {
    const result = await (client[name] as (input: unknown) => Promise<unknown>)(
      inputs[name],
    );
    assert.deepEqual(result, outputs[name]);
    const dispatch = calls.at(-1);
    assert.equal(dispatch.name, "actions.call");
    assert.equal(dispatch.input.installationId, "explicit-onto");
    assert.equal(dispatch.input.action, documentOperations[name].action);
    assert.equal(dispatch.input.readOnly, documentOperations[name].readOnly);
  }
  assert.equal(calls.length, 9);
  assert.equal(
    typeof ontoClient(host, provider).documents.generate,
    "function",
  );
});
test("document clients reject incompatible providers and injected authority before dispatch", async () => {
  let calls = 0;
  const host = {
    call: async () => {
      calls++;
      throw new Response("Denied", { status: 403 });
    },
  } as unknown as WorkflowHost<"interactive">;
  assert.throws(
    () =>
      ontoDocumentsClient(host, {
        ...provider,
        contracts: [{ id: "other", version: 1 }],
      }),
    (e: any) => e.status === 409,
  );
  const client = ontoDocumentsClient(host, provider);
  await assert.rejects(
    client.create({ ...inputs.create, owner: "foreign" } as never),
  );
  assert.equal(calls, 0);
  await assert.rejects(client.seal({ ...inputs.seal, capture } as never));
  assert.equal(calls, 0);
  await assert.rejects(
    client.generate(inputs.generate),
    (e: any) => e.status === 403,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    client.generate(inputs.generate),
    (e: any) => e.status === 403,
  );
  assert.equal(calls, 2);
});
test("malformed receipts fail explicitly without retrying a write", async () => {
  let calls = 0;
  const host = {
    call: async () => {
      calls++;
      return { sealed: true, revision: 1, digest, approval: "approved" };
    },
  } as unknown as WorkflowHost<"interactive">;
  await assert.rejects(ontoDocumentsClient(host, provider).seal(inputs.seal));
  assert.equal(calls, 1);
});
test("generation and retry preserve dispatched, pending and older queued receipts", async () => {
  const receipts = [
    { queued: true, jobId: "job", runId: "run" },
    {
      queued: true,
      jobId: "job",
      dispatch: "pending",
      message: "Generation is queued; an authorized schedule can process it.",
    },
    { queued: true, jobId: "job", runId: "retry-run" },
    {
      queued: true,
      jobId: "job",
      dispatch: "pending",
      message: "Retry dispatch pending.",
    },
    { queued: true },
  ];
  let index = 0;
  const host = {
    call: async () => receipts[index++],
  } as unknown as WorkflowHost<"interactive">;
  const client = ontoDocumentsClient(host, provider);
  assert.deepEqual(await client.generate(inputs.generate), receipts[0]);
  assert.deepEqual(await client.generate(inputs.generate), receipts[1]);
  assert.deepEqual(await client.retry(inputs.retry), receipts[2]);
  assert.deepEqual(await client.retry(inputs.retry), receipts[3]);
  assert.deepEqual(await client.retry(inputs.retry), receipts[4]);
  assert.equal(index, 5);
});

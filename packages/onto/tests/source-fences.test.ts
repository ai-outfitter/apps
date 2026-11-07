import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveOntoSourceFence,
  ontoSourceFenceCapability,
  ontoSourceFenceContract,
  sourceFenceInput,
} from "../src/source-fences";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";

test("source fences require explicit independent contract and capability discovery", async () => {
  const calls: unknown[] = [];
  const host = {
    call: async (operation: string, input: unknown) => {
      calls.push(input);
      if (operation === "actions.list")
        return [
          {
            installationId: "bound",
            actions: [
              { name: "graph.describe", access: "read", permitted: true },
            ],
          },
        ];
      return {
        version: 1,
        contracts: [ontoSourceFenceContract],
        capabilities: [ontoSourceFenceCapability],
        types: [],
        queryAction: "graph.graphql",
      };
    },
  } as unknown as WorkflowHost<"interactive">;
  const client = await resolveOntoSourceFence(host, {
    installationId: "bound",
  });
  await assert.rejects(
    resolveOntoSourceFence(
      host,
      { installationId: "bound" },
      "direct-neighborhood-v1",
    ),
  );
  assert.equal(client.provider.installationId, "bound");
  assert.deepEqual(calls[0], { installationId: "bound" });
  const ordinary = {
    call: async (operation: string) =>
      operation === "actions.list"
        ? [
            {
              installationId: "graph",
              actions: [
                { name: "graph.describe", access: "read", permitted: true },
              ],
            },
          ]
        : {
            version: 1,
            contracts: [{ id: "outfitter.onto", version: 1 }],
            capabilities: ["graphql.read"],
            types: [],
            queryAction: "graph.graphql",
          },
  } as unknown as WorkflowHost<"interactive">;
  await assert.rejects(
    resolveOntoSourceFence(ordinary, { installationId: "graph" }),
  );
  assert.equal(
    sourceFenceInput.safeParse({
      provider: client.provider,
      proofId: crypto.randomUUID(),
      subject: {
        installationId: "bound",
        type: "graph-node",
        id: crypto.randomUUID(),
        revision: 1,
        digest: "a".repeat(64),
      },
      idempotencyKey: "request",
      proof: { complete: true },
    }).success,
    false,
  );
});

test("source clients reject valid-schema foreign receipts", async () => {
  const subject = {
    installationId: "bound",
    type: "graph-node" as const,
    id: crypto.randomUUID(),
    revision: 1,
    digest: "a".repeat(64),
  };
  const proof = {
    version: 1,
    id: crypto.randomUUID(),
    provider: {
      installationId: "bound",
      contract: ontoSourceFenceContract.id,
      version: 1,
    },
    scope: { owner: "user:owner", organizationId: null },
    selection: {
      definitionId: "reviewed",
      definitionVersion: 1,
      definitionDigest: "b".repeat(64),
      kind: "whole-owner-type-membership-v1",
    },
    subject,
    issuedAt: 1,
    expiresAt: 2,
    completeness: { complete: true, errors: [] },
    types: [],
    readSets: [
      {
        type: "graph-node",
        typeId: crypto.randomUUID(),
        includeArchived: false,
        records: [],
      },
    ],
    records: [],
    snapshot: {},
    snapshotDigest: "c".repeat(64),
  };
  let response: unknown = proof;
  const host = {
    call: async (operation: string, input: { action?: string }) => {
      if (operation === "actions.list")
        return [
          {
            installationId: "bound",
            actions: [
              { name: "graph.describe", access: "read", permitted: true },
            ],
          },
        ];
      if (input.action === "graph.describe")
        return {
          version: 1,
          contracts: [ontoSourceFenceContract],
          capabilities: [ontoSourceFenceCapability],
          types: [],
          queryAction: "graph.graphql",
        };
      return response;
    },
  } as unknown as WorkflowHost<"interactive">;
  await assert.rejects(resolveOntoSourceFence(host, undefined as never));
  const client = await resolveOntoSourceFence(host, {
    installationId: "bound",
  });
  const capture = {
    definitionId: "reviewed",
    definitionVersion: 1,
    requestKey: "capture",
    subject,
  };
  assert.deepEqual(await client.capture(capture), proof);
  for (const foreign of [
    {
      ...proof,
      selection: { ...proof.selection, kind: "direct-neighborhood-v1" },
    },
    { ...proof, provider: { ...proof.provider, installationId: "foreign" } },
    { ...proof, subject: { ...subject, digest: "d".repeat(64) } },
    { ...proof, selection: { ...proof.selection, definitionId: "other" } },
    { ...proof, selection: { ...proof.selection, definitionVersion: 2 } },
  ]) {
    response = foreign;
    await assert.rejects(client.capture(capture));
  }
  const fence = { proofId: proof.id, subject, idempotencyKey: "seal" };
  response = {
    status: "sealed",
    proofId: crypto.randomUUID(),
    sourceSeal: subject,
  };
  await assert.rejects(client.fence(fence));
  response = {
    status: "sealed",
    proofId: proof.id,
    sourceSeal: { ...subject, installationId: "foreign" },
  };
  await assert.rejects(client.fence(fence));
  await assert.rejects(client.status({ idempotencyKey: "seal" }));
  response = { status: "sealed", proofId: proof.id, sourceSeal: subject };
  assert.deepEqual(await client.fence(fence), response);
});

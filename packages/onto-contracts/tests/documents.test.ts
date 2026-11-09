import test from "node:test";
import assert from "node:assert/strict";
import {
  documentDefinition,
  documentDefineInput,
  documentContract,
  documentSealInput,
  documentOperations,
} from "../src/index";

test("portable definitions retain provider-owned object config without a platform dependency", () => {
  const config = {
    kind: "compatible-fork",
    selection: { collection: "work", at: "2026-11-07" },
  };
  const parsed = documentDefinition.parse({
    sources: [{ provider: "forked-source", config }],
    policy: { provider: "replacement-policy", config: "v1", required: true },
  });
  assert.deepEqual(parsed.sources[0].config, config);
  assert.equal(parsed.retention, "owner-retained");
  assert.equal(
    documentDefinition.safeParse({
      sources: [{ provider: "fork", config: "opaque serialized config" }],
    }).success,
    false,
  );
  assert.equal(
    documentDefinition.safeParse({
      sources: [
        { provider: "fork", config: { oversized: "x".repeat(131073) } },
      ],
    }).success,
    false,
  );
});
test("document schemas reject authority injection, invalid periods and rendering pointers", () => {
  assert.equal(
    documentDefineInput.safeParse({
      id: "doc",
      version: 1,
      owner: "another-owner",
      definition: {
        sources: [{ provider: "graph", config: { query: "{ title }" } }],
      },
    }).success,
    false,
  );
  assert.equal(
    documentSealInput.safeParse({
      id: "doc",
      revision: 1,
      digest: "a".repeat(64),
      capture: { complete: true },
    }).success,
    false,
  );
  const contract = {
    version: 1,
    identity: "roadmap",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    params: {},
    period: { start: "2026-11-08T00:00:00Z", end: "2026-11-07T00:00:00Z" },
    rendering: {
      mode: "combined",
      template: "roadmap",
      sections: [
        {
          title: "Work",
          provider: "graph",
          pointer: "/bad~escape",
          required: true,
        },
      ],
    },
    refresh: "manual",
    requirements: { evidence: true, seal: true, export: true },
  };
  assert.equal(documentContract.safeParse(contract).success, false);
  assert.equal(
    documentContract.safeParse({
      ...contract,
      period: { start: contract.period.end, end: contract.period.start },
      rendering: {
        ...contract.rendering,
        sections: [
          { ...contract.rendering.sections[0], pointer: "/work~1items/0" },
        ],
      },
    }).success,
    true,
  );
});
test("operation registry keeps read intent separate from mutations and seals separate from approval", () => {
  assert.deepEqual(
    Object.entries(documentOperations)
      .filter(([, operation]) => operation.readOnly)
      .map(([name]) => name),
    ["live", "revision", "job", "policy"],
  );
  assert.equal(
    documentOperations.seal.output.safeParse({
      sealed: true,
      revision: 1,
      digest: "a".repeat(64),
      approval: "approved",
    }).success,
    false,
  );
});
test("serialized source configuration is distinct from short policy config identifiers", async () => {
  const { documentSerializedSourceBinding, documentProviderBinding } =
    await import("../src/documents");
  const config = JSON.stringify({ query: "x".repeat(1024) });
  assert.equal(
    documentSerializedSourceBinding.safeParse({ provider: "source", config })
      .success,
    true,
  );
  assert.equal(
    documentProviderBinding.safeParse({ provider: "policy", config }).success,
    false,
  );
  assert.equal(
    documentSerializedSourceBinding.safeParse({
      provider: "source",
      config: "x".repeat(131073),
    }).success,
    false,
  );
});

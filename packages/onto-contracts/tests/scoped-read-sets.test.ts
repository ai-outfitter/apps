import test from "node:test";
import assert from "node:assert/strict";
import { graphChangeInput } from "../src/index";

test("scoped membership accepts only exact edge endpoint predicates", () => {
  const set = {
    type: "graph-edge",
    typeId: crypto.randomUUID(),
    includeArchived: false,
    endpoint: { direction: "outgoing", nodeId: crypto.randomUUID() },
    records: [],
  };
  const request = {
    requestKey: "capture",
    readSets: [set],
    operations: [
      { operation: "create", ref: "$seal", type: "graph-node", attributes: {} },
    ],
  };
  assert.equal(graphChangeInput.safeParse(request).success, true);
  for (const invalid of [
    { ...set, type: "graph-node" },
    { ...set, endpoint: { ...set.endpoint, direction: "either" } },
    { ...set, endpoint: { ...set.endpoint, nodeId: "slug" } },
    { ...set, endpoint: { ...set.endpoint, complete: true } },
  ])
    assert.equal(
      graphChangeInput.safeParse({ ...request, readSets: [invalid] }).success,
      false,
    );
});

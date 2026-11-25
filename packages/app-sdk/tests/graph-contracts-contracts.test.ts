import { test } from "node:test";
import assert from "node:assert/strict";
import { batchOpenInput, batchPolicy, batchReviewInput } from "../src/graph-contracts/index";
test("Onto policies preserve member review defaults and confidence floors", () => {
  assert.deepEqual(batchOpenInput.parse({ title: "Review" }).policy, { kind: "member" });
  assert.equal(batchPolicy.safeParse({ kind: "confidence", threshold: 0.89, version: "v1" }).success, false);
});

test("review input preserves omitted versions and validates an explicit version", () => {
  const input = { batchId: "10000000-0000-4000-8000-000000000001", verdict: "approve" };
  assert.deepEqual(batchReviewInput.parse(input), input);
  for (const expectedVersion of [0, 2]) {
    const versioned = { ...input, expectedVersion };
    assert.deepEqual(batchReviewInput.parse(versioned), versioned);
  }
  for (const expectedVersion of [-1, 1.5, "2", null]) {
    assert.equal(batchReviewInput.safeParse({ ...input, expectedVersion }).success, false);
  }
});

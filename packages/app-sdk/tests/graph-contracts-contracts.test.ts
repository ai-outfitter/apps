import { test } from "node:test";
import assert from "node:assert/strict";
import { batchOpenInput, batchPolicy } from "../src/graph-contracts/index";
test("Onto policies preserve member review defaults and confidence floors", () => {
  assert.deepEqual(batchOpenInput.parse({ title: "Review" }).policy, { kind: "member" });
  assert.equal(batchPolicy.safeParse({ kind: "confidence", threshold: 0.89, version: "v1" }).success, false);
});

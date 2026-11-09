import { test } from "node:test";
import assert from "node:assert/strict";
import * as contracts from "../src/graph-contracts/index";
import { evidenceList } from "@ai-outfitter/app-sdk/evidence";
import { evidenceList as neutralEvidence } from "@ai-outfitter/connector-core/evidence";
test("SDK evidence forwards the neutral connector-core schema", () => {
  assert.equal(evidenceList, neutralEvidence);
});
test("Onto batch policies preserve review thresholds and defaults", () => {
  assert.deepEqual(contracts.batchOpenInput.parse({ title: "Review" }).policy, { kind: "member" });
  assert.equal(contracts.batchPolicy.safeParse({ kind: "confidence", threshold: 0.89, version: "v1" }).success, false);
  assert.equal(contracts.batchPolicy.safeParse({ kind: "confidence", threshold: 0.9, version: "v1" }).success, true);
});

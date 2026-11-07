import { test } from "node:test";
import assert from "node:assert/strict";
import * as contracts from "../src/contracts";
import * as legacy from "@ai-outfitter/app-sdk/wiki";
import { wikiGraphReadResult } from "@ai-outfitter/app-sdk/wiki-graph";
import { evidenceList } from "@ai-outfitter/app-sdk/evidence";
import { evidenceList as neutralEvidence } from "@ai-outfitter/connector-core/evidence";
test("SDK compatibility imports reference the canonical contract objects", () => {
  for (const name of ["nodeInput", "edgeInput", "typeInput", "assertionBody", "ontologyContract", "wikiGraph"] as const) assert.equal(legacy[name], contracts[name]);
  assert.equal(wikiGraphReadResult, contracts.wikiGraphReadResult);
  assert.equal(evidenceList, neutralEvidence);
});
test("Onto batch policies preserve review thresholds and defaults", () => {
  assert.deepEqual(contracts.batchOpenInput.parse({ title: "Review" }).policy, { kind: "member" });
  assert.equal(contracts.batchPolicy.safeParse({ kind: "confidence", threshold: 0.89, version: "v1" }).success, false);
  assert.equal(contracts.batchPolicy.safeParse({ kind: "confidence", threshold: 0.9, version: "v1" }).success, true);
});

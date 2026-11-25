import assert from "node:assert/strict";
import test from "node:test";
import { strToU8 } from "fflate";
import { parseSlicedPrintPackage } from "../src/server/print-plates";

import { archive, hash, loadSource, members, nativePlateMap, nativeRotation, parts, plates, report, stl } from "./fixtures/print-package";

const badRequest = (error:unknown) => error instanceof Response && error.status === 400;

test("verifies translated component meshes and rigid placements with repeated instances", async () => {
  const result = await parseSlicedPrintPackage(archive(),report,plates,parts,loadSource);
  assert.deepEqual(result.plates,[{...plates[0],durationSeconds:131.5,filamentGrams:12.453,warnings:[]}]);
  assert.equal(result.printer,"Bambu Lab P2S");
  assert.equal(result.material,"Generic ASA");
  assert.equal(result.slicer,"Bambu Studio 02.08.00.50");
});

test("rejects same-name replacement STL with different geometry and identical bounds or triangle counts", async () => {
  const replacement = stl(1.1);
  const digest = hash(replacement);
  await assert.rejects(parseSlicedPrintPackage(archive(),report,[{...plates[0],members:[{...members[0],sha256:digest}]}],
    [{...parts[0],sha256:digest}],async()=>replacement),
    badRequest);
});

test("requires toolpaths, stored source proof, exact quantities and unmodified build scale", async () => {
  await assert.rejects(parseSlicedPrintPackage(archive(false),report,plates,parts,loadSource),badRequest);
  await assert.rejects(parseSlicedPrintPackage(archive(),report,plates,parts,async()=>undefined),badRequest);
  await assert.rejects(parseSlicedPrintPackage(archive(),report,[{...plates[0],members:[{...members[0],quantity:1}]}],parts,loadSource),badRequest);
  await assert.rejects(parseSlicedPrintPackage(archive(true,"0 -2 0 2 0 0 0 0 2 20 30 0"),report,plates,parts,loadSource),badRequest);
  const wrongMapping = strToU8(new TextDecoder().decode(nativePlateMap).replace('value="12"','value="11"'));
  await assert.rejects(parseSlicedPrintPackage(archive(true,nativeRotation,wrongMapping),report,plates,parts,loadSource),badRequest);
});

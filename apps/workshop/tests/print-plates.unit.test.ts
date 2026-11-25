import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { parseSlicedPrintPackage } from "../src/server/print-plates";

const sha256 = "a".repeat(64);
const itemId = "11111111-1111-4111-8111-111111111111";
const members = [{itemId,sha256,quantity:2}];
const parts = [{itemId,sha256,fileName:"bracket.stl",quantity:2}];
const plates = [{index:1,name:"Plate 1",members}];
const settings = strToU8(JSON.stringify({printer_model:"Bambu Lab P2S",filament_settings_id:["Generic ASA"]}));
const report = strToU8(JSON.stringify({return_code:0,sliced_plates:[{
  id:1,total_predication:131.5,warning_message:"",filaments:[{total_used_g:12.453}],
  objects:[{name:"bracket.stl"},{name:"bracket.stl"}],
}]}));
const nativeSummary = strToU8(`<config><plate>
  <metadata key="index" value="1"/>
  <metadata key="prediction" value="131"/>
  <metadata key="weight" value="12.45"/>
  <object identify_id="1" name="bracket.stl" skipped="false" />
  <object identify_id="2" name="bracket.stl" skipped="false" />
</plate></config>`);
const archive = (toolpath = true) => zipSync({
  "Metadata/project_settings.config":settings,
  "Metadata/slice_info.config":nativeSummary,
  ...(toolpath && {"Metadata/plate_1.gcode":strToU8("G1 X8 E1")}),
});
const badRequest = (error:unknown) => error instanceof Response && error.status === 400;

test("retains grouped mass and time from the native outputs at their full precision", async () => {
  const result = await parseSlicedPrintPackage(archive(),report,plates,parts);
  assert.deepEqual(result.plates,[{...plates[0],durationSeconds:131.5,filamentGrams:12.453,warnings:[]}]);
  assert.equal(result.printer,"Bambu Lab P2S");
  assert.equal(result.material,"Generic ASA");
});

test("requires actual toolpaths, matching current digests, and exact native grouping", async () => {
  await assert.rejects(parseSlicedPrintPackage(archive(false),report,plates,parts),badRequest);
  await assert.rejects(parseSlicedPrintPackage(archive(),report,plates,[{...parts[0],sha256:"b".repeat(64)}]),badRequest);
  await assert.rejects(parseSlicedPrintPackage(archive(),report,[{...plates[0],members:[{...members[0],quantity:1}]}],parts),badRequest);
});

import assert from "node:assert/strict";
import test from "node:test";
import { machinePrintFindings } from "../src/server/print-analysis";

test("print mutation findings retain the checked identity and layer without parsing a warning", () => {
  const target = {itemId:"11111111-1111-4111-8111-111111111111",fileName:"bracket.stl",sha256:"a".repeat(64)};
  const profileSha256 = "b".repeat(64);
  assert.deepEqual(machinePrintFindings(target,{state:"pending",profileSha256}), [
    {...target,profileSha256,state:"pending",code:"check_pending"},
  ]);
  assert.deepEqual(machinePrintFindings(target,{state:"completed",profileSha256,
    result:{status:"fail",findings:[{z_mm:3.7,unsupported_area_mm2:12.5}]}}), [
    {...target,profileSha256,state:"completed",status:"fail",code:"unsupported_area",value:12.5,unit:"mm2",location:{zMm:3.7}},
  ]);
  assert.deepEqual(machinePrintFindings(target,{state:"completed",profileSha256,result:{status:"pass"}}),[]);
});

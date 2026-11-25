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

test("analyzer lookup is job-versioned by the host and the checked profile matches the packaged INI", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { analyzePrint } = await import("../src/server/print-analysis");
  const ini = await readFile(new URL("../box/workspace/fdm-asa.ini",import.meta.url));
  const profileSha256 = createHash("sha256").update(ini).digest("hex");
  const source = {name:"bracket.stl",sha256:"a".repeat(64)};
  const analyzerDigest = "sha256:"+"b".repeat(64);
  let resultProfile = profileSha256;
  const context = {host:()=>({call:async (operation:string,input:unknown)=>{
    assert.equal(operation,"fabrication.preflight");
    assert.deepEqual(input,{lookup:{kind:"stl",supportPolicy:"support-free",files:[source]}});
    return {id:"f".repeat(64),profile:analyzerDigest,state:"completed",result:{
      sha256:source.sha256,profile_sha256:resultProfile,status:"pass",
    }};
  }})} as Parameters<typeof analyzePrint>[0];
  const result = await analyzePrint(context,source,"support-free");
  assert.equal(result.state,"completed");
  assert.equal(result.profileSha256,profileSha256);
  assert.equal(result.analyzerDigest,analyzerDigest);
  resultProfile = "0".repeat(64);
  assert.equal((await analyzePrint(context,source,"support-free")).state,"stale");
});

test("only an explicit attachment retry requeues a terminal job", async () => {
  const { createHash } = await import("node:crypto");
  const { analyzePrint } = await import("../src/server/print-analysis");
  const bytes = new TextEncoder().encode("attachment");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const source = { name:"bracket.stl",sha256,bytes };
  const receipt = {id:"a".repeat(64),profile:"sha256:"+"b".repeat(64)};
  const calls:unknown[] = [];
  const context = {host:()=>({call:async (_operation:string,input:Record<string,unknown>)=>{
    calls.push(input);
    return {...receipt,state:input.lookup ? "error" : "queued"};
  }})} as Parameters<typeof analyzePrint>[0];
  assert.equal((await analyzePrint(context,source)).state,"error");
  assert.equal(calls.length,1);
  assert.equal((await analyzePrint(context,source,undefined,true)).state,"pending");
  assert.deepEqual(calls[2],{request:{kind:"stl",supportPolicy:undefined,files:[{
    name:source.name,sha256,base64:Buffer.from(bytes).toString("base64"),
  }]},retry:true});
});

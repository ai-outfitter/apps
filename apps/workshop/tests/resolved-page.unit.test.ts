import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ResolvedAssembly } from "../src/lib/assembly-resolution";
import { resolvedPage } from "../src/lib/resolved-page";

test("a robotics builder can reconstruct one oversized CAD record across Unicode boundaries",()=>{
  const record:ResolvedAssembly={projectId:"vehicle",revision:1,assembly:{items:[]},sources:[],meshes:{},
    buildPrice:{knownSubtotal:0,estimatedSubtotal:0,unpricedUnits:0}};
  record.sources.push({itemId:"mount",projectId:"arm",revision:2,name:"🌱".repeat(80000),pinned:false});
  let page=resolvedPage(record), text=page.jsonText;
  const first=page.nextCursor!;
  assert.ok(first);
  while(page.nextCursor){
    page=resolvedPage(record,page.nextCursor);
    assert.equal(page.offset,Buffer.byteLength(text));
    text+=page.jsonText;
  }
  assert.deepEqual(JSON.parse(text),record);
  assert.equal(Buffer.byteLength(text),page.totalBytes);
  assert.equal(createHash("sha256").update(text).digest("hex"),page.sha256);
  record.sources[0].revision++;
  assert.throws(()=>resolvedPage(record,first),/changed/);
});

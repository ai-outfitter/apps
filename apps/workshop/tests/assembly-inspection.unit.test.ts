import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {inspectionLink, sizingConfigurations} from "../src/lib/inspection-links";
import {resolveAssembly} from "../src/lib/assembly-resolution";
import { AssemblySchema } from "../src/lib/assembly";
import { immediatePath, inspectionOccurrences, inspectionOffsets } from "../src/lib/assembly-inspection";

test("tier 2 field instrument keeps repeated rotated cartridges separate, with world-Z automatic and parent-local authored offsets", () => {
  const [root, cartridge, sensor, plug, first, second, boardUse, plugUse, bracket, bracketUse] = Array.from({length:10}, () => randomUUID());
  const item = (id:string, name:string) => ({id,name,number:name,revision:"A",kind:"assembly"});
  const use = (id:string,itemId:string) => ({id,itemId,quantity:1});
  const view = AssemblySchema.parse({rootId:root,items:[
    {...item(root,"Instrument"),uses:[use(first,cartridge),{...use(second,cartridge),orientation:[90,0,90]}]},
    {...item(cartridge,"Cartridge"),uses:[{...use(boardUse,sensor),explode:{offset:[20,0,0]}},{...use(plugUse,plug),explode:{offset:[0,0,10],step:2}},{...use(bracketUse,bracket),quantity:3}]},
    item(sensor,"Sensor"),item(plug,"Plug"),{...item(bracket,"Bracket"),kind:"printed",
      geometry:{version:1,units:"mm",features:[{kind:"box",mode:"add",origin:[-12,-50,-5],size:[24,100,10]}]}}
  ]});
  const snapshot=JSON.stringify(view);
  const occurrences=inspectionOccurrences(view);
  const assembly=occurrences.get(root)!;
  const [a,b]=assembly.children;
  const offsets=inspectionOffsets(assembly,100);
  assert.notEqual(offsets.get(a.path)!.z, offsets.get(b.path)!.z);
  const [board, connector, ...brackets] = b.children;
  assert.equal(immediatePath(root,board.path),b.path);
  const mid=inspectionOffsets(b,50);
  const authored = mid.get(board.path)!;
  assert.ok(Math.abs(authored.x)<1e-8);
  assert.ok(Math.abs(authored.y)<1e-8);
  assert.ok(Math.abs(authored.z-20)<1e-8);
  assert.equal(mid.get(connector.path)!.length(),0);
  const full=inspectionOffsets(b,100);
  assert.ok(Math.abs(full.get(connector.path)!.y+10)<1e-8);
  assert.ok(Math.abs(full.get(connector.path)!.z)<1e-8);
  assert.deepEqual(brackets.map(entry => entry.bounds.min.z), Array(3).fill(brackets[0].bounds.min.z));
  for (const entry of brackets) assert.equal(full.has(entry.path), false);
  for (const delta of inspectionOffsets(b,0).values()) assert.equal(delta.length(),0);
  assert.equal(JSON.stringify(view),snapshot);
});


test("old bookmarks recover the real variant while genuine configurations and unrelated parameters survive",()=>{
  const base = randomUUID();
  const project = AssemblySchema.parse({rootId:base,items:[{id:base,kind:"assembly",name:"Node",number:"Node",revision:"A"}],configurations:[{name:"alpha",rootId:base},{name:"Assembled",rootId:base}]});
  const old = new URLSearchParams({configuration:"alpha-exploded",parameters:JSON.stringify({Explode:0.6,width:12})});
  const resolved = inspectionLink(project,old)!;
  assert.equal(resolved.get("configuration"),"alpha");
  assert.equal(resolved.get("explode"),"60");
  assert.deepEqual(JSON.parse(resolved.get("parameters")!),{width:12});
  assert.equal(inspectionLink(project,new URLSearchParams("configuration=Exploded"))?.get("configuration"),"Assembled");
  assert.equal(inspectionLink(project,new URLSearchParams("configuration=unrelated-exploded")),undefined);
  project.configurations!.push({name:"Exploded",rootId:base});
  assert.equal(inspectionLink(project,new URLSearchParams("configuration=Exploded")),undefined);
});


test("an unpinned referenced old inspection name resolves to a current physical variant", async () => {
  const [product, part, owner, refId] = Array.from({length:4},()=>randomUUID());
  const record = (id:string,name:string) => ({id,kind:"assembly",name,number:name,revision:"A"});
  const partSource = {id:owner,name:"Sensor module",revision:4,assembly:AssemblySchema.parse({
    rootId:part,items:[record(part,"Cartridge")],configurations:[{name:"field",rootId:part}]
  })};
  const consumer = {id:product,name:"Instrument",revision:2,assembly:AssemblySchema.parse({
    rootId:refId,items:[{...record(refId,"Installed sensor"),reference:{projectId:owner,configuration:"field-exploded",parameters:{Explode:1}}}]
  })};
  const result = await resolveAssembly(consumer,async () => partSource);
  assert.equal(result.sources[0].configuration,"field");
  assert.equal(result.assembly.rootId,refId);
  const knob = {name:"Explode",min:0,max:1,defaultValue:0,placements:[]};
  partSource.assembly.configurations![0].parameters=[knob];
  assert.equal(sizingConfigurations(partSource.assembly)?.[0].parameters?.length,1);
  partSource.assembly.configurations!.push({name:"field-exploded",rootId:part,parameters:[{...knob,defaultValue:1}]});
  assert.deepEqual(sizingConfigurations(partSource.assembly)?.map(c=>[c.name,c.parameters?.length]),[["field",0]]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {inspectionLink, sizingConfigurations} from "../src/lib/inspection-links";
import {resolveAssembly} from "../src/lib/assembly-resolution";
import { boxPlan } from "../src/model/cad-plan";
import { AssemblySchema } from "../src/lib/assembly";
import { immediatePath, inspectionOccurrences, inspectionOffsets } from "../src/lib/assembly-inspection";

test("tier 2 field instrument keeps repeated rotated cartridges separate, with ordered local offsets", () => {
  const [root, cartridge, sensor, plug, first, second, boardUse, plugUse] = Array.from({length:8}, () => randomUUID());
  const item = (id:string, name:string) => ({id,name,number:name,revision:"A",kind:"assembly"});
  const use = (id:string,itemId:string) => ({id,itemId,quantity:1});
  const view = AssemblySchema.parse({rootId:root,items:[
    {...item(root,"Instrument"),uses:[use(first,cartridge),{...use(second,cartridge),rotation:90}]},
    {...item(cartridge,"Cartridge"),uses:[{...use(boardUse,sensor),explode:{offset:[20,0,0]}},{...use(plugUse,plug),explode:{offset:[0,0,10],step:2}}]},
    item(sensor,"Sensor"),item(plug,"Plug")
  ]});
  const snapshot=JSON.stringify(view);
  const occurrences=inspectionOccurrences(view);
  const assembly=occurrences.get(root)!;
  const [a,b]=assembly.children;
  const offsets=inspectionOffsets(assembly,100);
  assert.notDeepEqual(offsets.get(a.path),offsets.get(b.path));
  const [board,connector]=b.children;
  assert.equal(immediatePath(root,board.path),b.path);
  const mid=inspectionOffsets(b,50);
  assert.ok(Math.abs(mid.get(board.path)!.x)<1e-8);
  assert.ok(Math.abs(mid.get(board.path)!.y-20)<1e-8);
  assert.equal(mid.get(connector.path)!.length(),0);
  assert.equal(inspectionOffsets(b,100).get(connector.path)!.z,10);
  assert.equal(inspectionOffsets(b,0).get(board.path)!.length(),0);
  assert.equal(JSON.stringify(view),snapshot);
});


test("a tilted assembly separates thick, coincident siblings on world Z while retaining authored offsets", () => {
  const [root, lid, layered, insert, spacer, fixed, lidUse, repeated, nested, authored] = Array.from({length: 10}, () => randomUUID());
  const item = (id: string, name: string) => ({ id, name, number: name, revision: "A", kind: "assembly" });
  const geometry = boxPlan(12, 18, 32);
  const view = AssemblySchema.parse({ rootId: root, items: [
    { ...item(root, "Field instrument"), uses: [{ id: lidUse, itemId: lid, quantity: 1, orientation: [90, 0, 0] }] },
    { ...item(lid, "Powered lid"), uses: [
      { id: repeated, itemId: layered, quantity: 2 },
      { id: authored, itemId: fixed, quantity: 1, explode: { offset: [0, 0, 24], step: 2 } },
    ] },
    { ...item(layered, "Stacked module"), uses: [{ id: nested, itemId: insert, quantity: 1 }] },
    { ...item(insert, "PCB"), kind: "pcb", geometry },
    { ...item(spacer, "Uninstalled spare"), kind: "fabricated", geometry },
    { ...item(fixed, "Authored connector"), kind: "cots", geometry },
  ] });
  const level = inspectionOccurrences(view).get(root)!.children[0];
  const [lower, upper, connector] = level.children;
  assert.deepEqual(lower.matrix.toArray(), upper.matrix.toArray());
  assert.deepEqual(inspectionOffsets(level, 0).get(lower.path)?.toArray().map(Math.abs), [0, 0, 0]);
  const full = inspectionOffsets(level, 100);
  for (const module of [lower, upper]) {
    assert.equal(full.get(module.path)?.x, 0);
    assert.equal(full.get(module.path)?.y, 0);
    assert.equal(full.has(module.children[0].path), false);
    assert.equal(immediatePath(level.path, module.children[0].path), module.path);
  }
  assert.ok(lower.bounds.max.z + full.get(lower.path)!.z < upper.bounds.min.z + full.get(upper.path)!.z);
  for (const module of [lower, upper]) {
    const offset = full.get(module.path)!.z;
    assert.ok(module.bounds.max.z + offset < connector.bounds.min.z ||
      module.bounds.min.z + offset > connector.bounds.max.z);
  }
  assert.equal(inspectionOffsets(level, 50).get(connector.path)!.length(), 0);
  const local = full.get(connector.path)!;
  assert.deepEqual(local.toArray().map(component => Math.round(component) + 0), [0, -24, 0]);
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

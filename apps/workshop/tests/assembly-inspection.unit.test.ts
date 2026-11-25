import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
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

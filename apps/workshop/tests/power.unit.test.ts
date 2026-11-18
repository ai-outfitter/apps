import test from "node:test";
import assert from "node:assert/strict";
import { AssemblySchema } from "../src/lib/assembly";
import { powerRollup } from "../src/lib/power";
const ids=["10000000-0000-4000-8000-000000000001","10000000-0000-4000-8000-000000000002","10000000-0000-4000-8000-000000000003"];
const values={averageW:4,operatingW:8,peakW:10};
function fixture(){return AssemblySchema.parse({rootId:ids[0],power:{version:1,notes:"Planning model",scenarios:[{id:"normal",name:"Normal",notes:""}],rails:[{id:"ac",name:"Wall",voltage:120,kind:"ac",efficiency:1,notes:""},{id:"dc24",name:"24V",voltage:24,kind:"dc",parent:"ac",efficiency:.8,notes:""},{id:"dc5",name:"5V",voltage:5,kind:"dc",parent:"dc24",efficiency:.5,notes:""}]},items:[
{id:ids[0],number:"ROOT",name:"Root",revision:"A",kind:"assembly",uses:[{id:ids[0],itemId:ids[1],quantity:2}]},
{id:ids[1],number:"SUB",name:"Sub",revision:"A",kind:"assembly",uses:[{id:ids[1],itemId:ids[2],quantity:3}]},
{id:ids[2],number:"LOAD",name:"Load",revision:"A",kind:"cots",power:{loads:[{id:"input",name:"Input",rail:"dc5",evidence:"modeled",source:"datasheet",notes:"",scenarios:{normal:values}}]}}
]});}
test("nested quantities and converter losses counted once; focused assembly is one instance",()=>{
 const a=fixture(),root=powerRollup(a,"normal")!,sub=powerRollup(a,"normal",ids[1])!;
 assert.equal(root.rows[0].quantity,6);assert.equal(root.total.peakW,150);assert.equal(root.total.averageW,60);assert.equal(root.dailyWh,1440);
 assert.equal(root.rails.find(r=>r.id==="dc24")!.values.peakW,120);assert.equal(sub.total.peakW,75);
 assert.deepEqual(powerRollup(AssemblySchema.parse(JSON.parse(JSON.stringify(a))),"normal"),root);
});
test("shared parts contribute for every placement; own parent loads add without stored child totals",()=>{
 const a=fixture();a.items[0].uses.push({id:ids[2],itemId:ids[2],quantity:1,refdes:"",position:[0,0,0],rotation:0});
 a.items[1].power={loads:[{...a.items[2].power!.loads[0],rail:"ac"}]};
 assert.equal(powerRollup(AssemblySchema.parse(a),"normal")!.total.peakW,195);
});
test("missing measurements propagate as unknown, not zero",()=>{
 const a=fixture();a.items[2].power!.loads[0].scenarios.normal.peakW=null;
 assert.equal(powerRollup(a,"normal")!.total.peakW,null);
 assert.equal(powerRollup(a,"normal")!.total.averageW,60);
 assert.equal(powerRollup(AssemblySchema.parse({items:[]}),"normal"),undefined);
});
test("reject rail cycles, invalid references, duplicate loads, missing scenarios and impossible values",()=>{
 for(const mutate of [
  (a:ReturnType<typeof fixture>)=>{a.power!.rails[0].parent="dc5";},
  (a:ReturnType<typeof fixture>)=>{a.items[2].power!.loads[0].rail="missing";},
  (a:ReturnType<typeof fixture>)=>{a.items[2].power!.loads.push(a.items[2].power!.loads[0]);},
  (a:ReturnType<typeof fixture>)=>{delete a.items[2].power!.loads[0].scenarios.normal;},
  (a:ReturnType<typeof fixture>)=>{a.items[2].power!.loads[0].scenarios.normal.averageW=11;},
 ]){const a=fixture();mutate(a);assert.equal(AssemblySchema.safeParse(a).success,false);}
});

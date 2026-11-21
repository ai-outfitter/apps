import assert from "node:assert/strict";
import test from "node:test";
import { Vector3, type Matrix4 } from "three";
import { AssemblySchema, bomTotals } from "../src/lib/assembly";
import { resolveAssembly, type AssemblySource } from "../src/lib/assembly-resolution";
import { installedOperations } from "../src/lib/installed-operations";

const item=(name:string)=>({id:crypto.randomUUID(),number:name,name,revision:"A",kind:"assembly"});
const use=(itemId:string)=>({id:crypto.randomUUID(),itemId,quantity:1});
const source=(name:string,assembly:unknown):AssemblySource=>({id:crypto.randomUUID(),name,revision:1,assembly:AssemblySchema.parse(assembly)});
const pos=(matrix:Matrix4)=>new Vector3().setFromMatrixPosition(matrix).toArray().map(n=>Math.round(n*1e6)/1e6);

// Tier 4: a chamber builder checks tool and tray positions in a rotated vehicle installation.
test("configured reference paths compose joints and preserve pose through pickup, transfer, release and rewind",async()=>{
 const arm=item("arm"), carriage=item("carriage"), tool=item("tool"), slide=use(carriage.id), wrist=use(tool.id);
 const robot=source("robot",{rootId:arm.id,configurations:[{name:"rack",rootId:arm.id}],items:[
  {...arm,uses:[{...slide,joint:{kind:"prismatic",axis:[1,0,0]}}]},
  {...carriage,uses:[{...wrist,joint:{kind:"revolute",axis:[0,0,1],pivot:[1,0,0]}}]},tool]});
 const chamber=item("chamber"), mount=item("mount"),tray=item("tray"),fixture=item("fixture");
 const armUse=use(mount.id),trayUse=use(tray.id),fixtureUse=use(fixture.id);
 const path=(...uses:{id:string}[])=>uses.map(u=>u.id+"#0").join("/");
 const slidePath=path(armUse,slide), toolPath=path(armUse,slide,wrist);
 const op={name:"Harvest",durationSeconds:4,tracks:[
  {path:slidePath,keys:[{time:0,value:0},{time:4,value:40}]},
  {path:toolPath,keys:[{time:0,value:0},{time:2,value:180}]}],
  handoffs:[{time:0,propPath:path(trayUse),carrierPath:toolPath},
   {time:2,propPath:path(trayUse),carrierPath:path(fixtureUse)},{time:3,propPath:path(trayUse)}]};
 const pod=source("pod",{rootId:chamber.id,items:[{...chamber,operations:[op],uses:[armUse,{...trayUse,position:[2,0,0]},fixtureUse]},
  {...mount,reference:{projectId:robot.id,configuration:"rack"}},tray,fixture]});
 const vehicle=item("vehicle"),slot=item("chamber mount"),install=use(slot.id);
 const ship=source("vehicle",{rootId:vehicle.id,items:[{...vehicle,uses:[{...install,quantity:2,rotation:90}]},{...slot,reference:{projectId:pod.id}}]});
 const lookup=async(ref:{projectId:string})=>ref.projectId===robot.id?robot:pod;
 const resolved=await resolveAssembly(ship,lookup);
 const [first,second]=installedOperations(resolved.assembly);
 assert.ok(first && second);
 const trayPath=first.path+"/"+path(trayUse);
 const pose=(t:number)=>pos(first.pose(t).get(trayPath)!);
 assert.deepEqual(pose(4),[0,20,0]);
 assert.deepEqual(pose(1),[-1,11,0]);
 assert.deepEqual(pose(2),pose(4));
 assert.deepEqual(pose(0),[0,2,0]);
 assert.equal(first.pose(3).has(second.path+"/"+path(trayUse)),false);
 assert.equal(bomTotals(resolved.assembly).lines.find(row=>row.item.number==="tray")?.quantity,2);
 pod.assembly.items[0].operations![0].tracks[0].path=path(armUse,fixtureUse);
 await assert.rejects(resolveAssembly(ship,lookup),/Invalid operation path/);
});

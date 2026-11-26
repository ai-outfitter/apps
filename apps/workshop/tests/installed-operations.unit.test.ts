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

// A grow-chamber builder closes a configured pair of jaws through a rotated installation.
test("installed child calls scale, hold, reverse, derive followers and measure actual face separation",async()=>{
 const hand=item("hand"),solid=item("jaw"),left=use(solid.id),right=use(solid.id), shaft=use(solid.id);
 const step=(u:{id:string})=>u.id+"#0";
 const L=step(left),R=step(right),S=step(shaft),axis=[1,0,0];
 const gripper=source("gripper",{rootId:hand.id,configurations:[{name:"adjustable",rootId:hand.id,parameters:[
  {name:"travel",min:0,max:8,defaultValue:4,placements:[{parentId:hand.id,usageId:right.id,axis:"x",scale:2,offset:4}]}]}],
  items:[{...hand,uses:[{...left,joint:{kind:"prismatic",axis}},{...right,joint:{kind:"prismatic",axis}},{...shaft,joint:{kind:"revolute",axis:[0,0,1]}}],
   couplings:[{driverPath:L,followerPath:R,ratio:-1},{driverPath:R,followerPath:S,ratio:-90}],
   operations:[{name:"Close",durationSeconds:2,tracks:[{path:L,keys:[{time:0,value:0},{time:2,value:0,parameter:"travel",scale:1}]}],
    expectations:[{kind:"distance",label:"Touch",time:2,path:L,point:[2,0,0],otherPath:R,otherPoint:[-2,0,0],expected:0,tolerance:.001},
     {kind:"direction",label:"Shaft mark",time:2,path:S,axis:[1,0,0],expected:[0,1,0],tolerance:.001}]}]},solid]});
 const rack=item("rack"),mounted=item("installed hand"),mount=use(mounted.id),m=step(mount);
 const consumer=source("rack",{rootId:rack.id,items:[{...rack,uses:[{...mount,position:[8,12,1],rotation:90}],
  operations:[{name:"Pick",durationSeconds:6,tracks:[],calls:[
   {path:m,operation:"Close",startSeconds:1,durationSeconds:1},{path:m,operation:"Close",startSeconds:4,durationSeconds:1,reverse:true}],
   expectations:[{kind:"joint",label:"Shaft degrees",path:m+"/"+S,time:3,expected:450,tolerance:0}]}]},
  {...mounted,reference:{projectId:gripper.id,configuration:"adjustable",parameters:{travel:5}}}]});
 const resolve=()=>resolveAssembly(consumer,async()=>gripper);
 const [pick]=installedOperations((await resolve()).assembly);
 const jawTime=(time:number)=>pos(pick.pose(time).get(pick.path+"/"+m+"/"+L)!);
 assert.deepEqual(jawTime(0),[8,12,1]); assert.deepEqual(jawTime(1.5),[8,14.5,1]);
 assert.deepEqual(jawTime(3),[8,17,1]); assert.deepEqual(jawTime(4.5),[8,14.5,1]); assert.deepEqual(jawTime(6),jawTime(0));
 const results=pick.checks();assert.deepEqual(results.map(r=>r.time),[3,2,2,4,4]);assert.ok(results.every(r=>r.passed));
 const child=gripper.assembly.items[0], op=consumer.assembly.items[0].operations![0], calls=op.calls!;
 calls[1].startSeconds=1.5;await assert.rejects(resolve,/Overlapping/);calls[1].startSeconds=4;
 calls[1].reverse=false;await assert.rejects(resolve,/Discontinuous/);calls[1].reverse=true;
 calls[0].operation="Missing";await assert.rejects(resolve,/Missing operation/);calls[0].operation="Close";
 child.couplings!.push({driverPath:S,followerPath:L,ratio:1});await assert.rejects(resolve,/Cyclic|coupled/);child.couplings!.pop();
 child.couplings!.push({driverPath:L,followerPath:S,ratio:1});await assert.rejects(resolve,/drivers|Conflicting/);child.couplings!.pop();
 child.operations![0].tracks[0].keys[1].parameter="unknown";await assert.rejects(resolve,/parameter unknown/);
});

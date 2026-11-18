import assert from 'node:assert/strict';
import test from 'node:test';
import {Matrix4,Vector3} from 'three';
import {sensorNodeAssembly} from '../src/lib/sensor-node';
import {savedDriveMotion,savedMotionMatrix} from '../src/lib/saved-drive-motion';

test('build motion binds saved usage instances and rejects stale or fabricated references',()=>{
 const a=sensorNodeAssembly();
 const parent=a.items.find(i=>i.uses.some(u=>a.items.find(c=>c.id===u.itemId)?.geometry))!;
 const use=parent.uses.find(u=>a.items.find(c=>c.id===u.itemId)?.geometry)!;
 const r={usageId:use.id,axis:[1,0,0],pivot:[0,0,0],radiansPerMillimeter:Math.PI/35};
 const spec={version:1,viewRootIds:[a.rootId],z:{levels:[{label:'Low',offset:0},{label:'High',offset:70}],translationUsageIds:[use.id],rotations:[r]}};
 const before=JSON.stringify(a),resolved=savedDriveMotion(spec,a,a)!;
 assert.ok(resolved.paths.size>0);assert.ok(resolved.rotations.length>0);
 assert.equal(JSON.stringify(a),before);
 assert.throws(()=>savedDriveMotion({...spec,z:{...spec.z,translationUsageIds:[crypto.randomUUID()]}},a,a),/absent/);
 assert.throws(()=>savedDriveMotion({...spec,z:{...spec.z,rotations:[{...r,usageId:crypto.randomUUID()}]}},a,a),/saved leaf solid/);
 assert.throws(()=>savedDriveMotion({...spec,z:{...spec.z,rotations:[{...r,axis:[0,0,0]}]}},a,a));
 assert.equal(savedDriveMotion(spec,a,{...a,rootId:use.itemId}),undefined);
 assert.throws(()=>savedDriveMotion({...spec,z:{...spec.z,levels:[...spec.z.levels].reverse()}},a,a),/strictly increase/);
});

test('shaft turns around its own saved pivot while the Z carriage translates',()=>{
 const rest=new Matrix4().makeTranslation(100,200,300),before=rest.clone();
 const r={usageId:crypto.randomUUID(),axis:[1,0,0] as [number,number,number],pivot:[2,3,4] as [number,number,number],radiansPerMillimeter:Math.PI/35};
 const pivot=new Vector3(...r.pivot);
 const result=savedMotionMatrix(rest,17.5,true,[r]);
 const expected=pivot.clone().applyMatrix4(rest).add(new Vector3(0,0,17.5));
 assert.ok(pivot.clone().applyMatrix4(result).distanceTo(expected)<1e-10);
 const point=pivot.clone().add(new Vector3(0,1,0)).applyMatrix4(result);
 assert.ok(point.distanceTo(expected.clone().add(new Vector3(0,0,1)))<1e-10);
 assert.deepEqual(rest,before);
 assert.deepEqual(savedMotionMatrix(rest,0,true,[r]),rest);
 assert.deepEqual(savedMotionMatrix(rest,70,false,[]),rest);
});

test('installed drive binds both reference hops and uses the mounted Z axis', async()=>{
 const {AssemblySchema}=await import('../src/lib/assembly');
 const {resolveAssembly}=await import('../src/lib/assembly-resolution');
 const {installedDriveMotion}=await import('../src/lib/saved-drive-motion');
 const item=(name:string)=>({id:crypto.randomUUID(),kind:'assembly',revision:'A',name,number:name});
 const use=(itemId:string)=>({id:crypto.randomUUID(),itemId,quantity:1});
 const rack=item('Rack'),compact=item('Compact'),shaft={...item('Shaft'),kind:'cots',geometry:{version:1,units:'mm',features:[{kind:'box',mode:'add',origin:[0,0,0],size:[2,2,10]}]}};
 const moving=use(shaft.id),fixed=use(shaft.id);
 const spec={version:1,viewRootIds:[rack.id],z:{levels:[{label:'Low',offset:0},{label:'High',offset:70}],translationUsageIds:[moving.id],rotations:[{usageId:moving.id,axis:[1,0,0],pivot:[1,0,0],radiansPerMillimeter:-0.1}]}};
 const raw={rootId:rack.id,items:[{...rack,driveMotion:spec,uses:[moving,fixed]},compact,shaft],configurations:[{name:'rack',rootId:rack.id},{name:'compact',rootId:compact.id}]};
 const source={id:crypto.randomUUID(),revision:1,name:'Source',assembly:AssemblySchema.parse(raw)};
 const mount=(name:string,sourceId:string,configuration?:string)=>{
  const root=item(name),ref=item('Mount');
  return {id:crypto.randomUUID(),revision:1,name,assembly:AssemblySchema.parse({rootId:root.id,items:[{...root,uses:[{...use(ref.id),orientation:configuration?[90,0,0]:[0,0,0]}]},{...ref,reference:{projectId:sourceId,configuration}}]})};
 };
 const chamber=mount('Chamber',source.id,'rack'),vehicle=mount('Vehicle',chamber.id);
 const sources=[source,chamber,vehicle];
 const read=async(ref:{projectId:string})=>sources.find(s=>s.id===ref.projectId)!;
 for(const project of sources){
  const {assembly}=await resolveAssembly(project,read);
  const owner=assembly.items.find(i=>i.driveMotion)!;
  const motion=installedDriveMotion(assembly)!;
  assert.deepEqual(motion.levels,spec.z.levels);
  assert.deepEqual([...motion.paths],motion.rotations.map(r=>r.path));
  assert.equal(motion.paths.size,1);
  assert.equal(motion.rotations[0].radiansPerMillimeter,-0.1);
  assert.deepEqual(motion.rotations[0].pivot,[1,0,0]);
  if(project!==source){
   assert.notEqual(owner.id,rack.id);
   assert.notEqual(owner.driveMotion!.z.rotations[0].usageId,moving.id);
   assert.deepEqual(owner.driveMotion!.viewRootIds,[owner.id]);
   assert.ok([...motion.axes.values()][0].distanceTo(new Vector3(0,-1,0))<1e-10);
  }
 }
 assert.equal(installedDriveMotion((await resolveAssembly(mount('Compact chamber',source.id,'compact'),read)).assembly),undefined);
 const bad=structuredClone(source.assembly);bad.items[0].driveMotion!.z.rotations[0].usageId=crypto.randomUUID();
 assert.equal(AssemblySchema.safeParse(bad).success,false);
});

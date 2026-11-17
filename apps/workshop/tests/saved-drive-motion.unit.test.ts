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

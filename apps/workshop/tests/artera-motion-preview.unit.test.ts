import assert from 'node:assert/strict';
import test from 'node:test';
import {AssemblySchema} from '../src/lib/assembly';
import {arteraMotionPreview} from '../src/lib/artera-motion-preview';

test('Artera team previews shelf travel with moving usage instances only (tier 4)',()=>{
 const ids=Array.from({length:7},()=>crypto.randomUUID());
 const use=(index:number,z=0)=>({id:crypto.randomUUID(),itemId:ids[index],quantity:1,position:[0,0,z]});
 const movingUse=use(3,300),fixedUse=use(3,500);
 const numbers=['POD-A001','MOTION-A001','POD-A003','MOTION-M002','MOTION-M001','MOTION-A011','BEARING'];
 const assembly=AssemblySchema.parse({rootId:ids[0],items:numbers.map((number,i)=>({
  id:ids[i],number,name:number,kind:i<3||i===5?'assembly':'cots',revision:'A',
  uses:i===0?[use(1,25),use(2,200),use(2,700),fixedUse]:i===1?[movingUse,use(4),use(5)]:i===5?[use(6)]:[],
  ...(i===3||i===4||i===6?{geometry:{version:1,units:'mm',features:[{kind:'box',mode:'add',origin:[0,0,0],size:[10,10,10]}]}}:{})
 }))});
 const before=JSON.stringify(assembly);
 const preview=arteraMotionPreview(assembly,assembly,{shelf_thickness:3,tray_depth:40})!;
 assert.deepEqual(preview.levels.map(l=>l.offset),[-186,314]);
 assert.equal(preview.paths.size,2);
 assert.ok([...preview.paths].some(path=>path.includes(movingUse.id)));
 assert.ok([...preview.paths].every(path=>!path.includes(fixedUse.id)));
 assert.equal(arteraMotionPreview(assembly,{...assembly,rootId:ids[2]},{shelf_thickness:3,tray_depth:40}),undefined);
 assert.equal(arteraMotionPreview(assembly,assembly,{}),undefined);
 assert.equal(JSON.stringify(assembly),before);
});

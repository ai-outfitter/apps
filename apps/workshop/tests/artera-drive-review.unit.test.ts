import assert from 'node:assert/strict';
import test from 'node:test';
import {AssemblySchema} from '../src/lib/assembly';
import {arteraDriveReview,Z_PITCH_RADIUS,zDriveTurns} from '../src/lib/artera-drive-review';
import {createZDriveInspection} from '../src/client/z-drive-inspection';

function fixture(){
 const ids=Array.from({length:4},()=>crypto.randomUUID());
 const use=(i:number,x:number,z:number)=>({id:crypto.randomUUID(),itemId:ids[i],quantity:1,position:[x,0,z]});
 return AssemblySchema.parse({rootId:ids[0],items:[
  {id:ids[0],number:'ROOT',name:'Artera Z review fixture',revision:'A',kind:'assembly',uses:[use(1,0,0),use(1,500,0),use(2,0,1652),use(2,500,1652),use(3,0,500),use(3,500,500)]},
  ...['MOTION-M001','MOTION-U005','MOTION-U001'].map((number,i)=>({id:ids[i+1],number,name:number,revision:'A',kind:'cots',mpn:i===0?'ZLW-1040-02-S-100-L-1500':i===1?'23HS22-2804D-B200':'',geometry:{version:1,units:'mm',features:[{kind:'box',mode:'add',origin:[0,0,0],size:[10,10,10]}]}}))
 ]});
}

test('tier 4 drive review cannot promote a complete-looking animation into mechanical acceptance',()=>{
 const assembly=fixture(),before=JSON.stringify(assembly),review=arteraDriveReview(assembly,assembly);
 assert.equal(review.status,'incomplete');assert.equal(review.drives.length,2);
 assert.deepEqual(review.missing,['MOTION-U003','MOTION-U014','MOTION-U007']);
 assert.equal(zDriveTurns(70),1);assert.equal(zDriveTurns(-35),-0.5);
 assert.ok(Math.abs(2*Math.PI*Z_PITCH_RADIUS-70)<1e-10);
 assert.equal(JSON.stringify(assembly),before);
 // Negative controls: missing motor, different supplier, missing carriage.
 const root=assembly.items[0];const motorUse=root.uses.splice(2,1)[0];
 assert.equal(arteraDriveReview(assembly,assembly).drives.length,0);root.uses.splice(2,0,motorUse);
 assembly.items[1].mpn='unknown axis';assert.equal(arteraDriveReview(assembly,assembly).drives.length,0);
});

test('drive inspection rotates shafts, moves belt marks, and leaves motor housings fixed',()=>{
 const assembly=fixture(),review=arteraDriveReview(assembly,assembly),overlay=createZDriveInspection(review.drives);
 const initial=overlay.group.children.map(n=>({position:n.position.clone(),rotation:n.rotation.clone()}));
 overlay.update(17.5);
 const rotated=overlay.group.children.filter((n,i)=>n.rotation.x!==initial[i].rotation.x);
 assert.equal(rotated.length,10);assert.ok(rotated.every(n=>n.rotation.x===Math.PI/2));
 const moved=overlay.group.children.filter((n,i)=>!n.position.equals(initial[i].position));
 assert.equal(moved.length,66); // 64 belt markers + 2 carriage attachment indicators
 overlay.update(0);
 assert.ok(overlay.group.children.every((n,i)=>n.position.equals(initial[i].position)&&n.rotation.equals(initial[i].rotation)));
 overlay.dispose();assert.equal(overlay.group.children.length,0);
});

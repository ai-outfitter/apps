import assert from 'node:assert/strict';
import test from 'node:test';
import { appArtifact } from '@ai-outfitter/app-test/prepare';
import { appWorker } from '@ai-outfitter/app-test/worker';
import { powerRollup } from '../src/lib/power';
const member={userId:'power-builder',organizationId:'power-fixture',role:'member'};
test('Artera prototype power data survives actual project save/read and rejects stale writes',async()=>{
 const app=await appWorker('workshop',appArtifact(new URL('..',import.meta.url),'operational'),'power-persistence');
 try{
  const create=await app.call('/api/apps/workshop/projects',member,{method:'POST',body:{example:'cube'}});
  assert.equal(create.status,201);const p=await create.json() as any;
  const id='10000000-0000-4000-8000-000000000001';
  const assembly={rootId:id,power:{version:1,notes:'Fixture',scenarios:[{id:'normal',name:'Normal',notes:''}],rails:[{id:'dc24',name:'Input',voltage:24,kind:'dc',efficiency:1,notes:''}]},items:[{id,number:'CTRL',revision:'A',kind:'assembly',name:'Controls',power:{loads:[{id:'input',name:'Input',rail:'dc24',evidence:'assumed',source:'Fixture',notes:'',scenarios:{normal:{averageW:3,operatingW:4,peakW:6}}}]}}]};
  const url=`/api/apps/workshop/projects/${p.id}`;
  const response=await app.call(url,member,{method:'PUT',body:{...p,assembly}});assert.equal(response.status,200,await response.clone().text());
  const saved=await response.json() as any;
  const fetched=await app.call(url,member);assert.equal(fetched.status,200);const read=await fetched.json() as any;
  assert.deepEqual(read.assembly,saved.assembly);assert.equal(powerRollup(read.assembly,'normal')!.total.peakW,6);
  assert.equal((await app.call(url,member,{method:'PUT',body:{...p,assembly}})).status,409);
 }finally{await app.dispose();}
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { appArtifact } from '@ai-outfitter/app-test/prepare';
import { appWorker } from '@ai-outfitter/app-test/worker';
const member={userId:'builder',organizationId:'fixture-org',role:'member'};
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('saved previews are revision-bound, authenticated, and include hashed capture evidence',async()=>{
 const app=await appWorker('workshop',appArtifact(new URL('..',import.meta.url),'operational'),'preview-test');
 try{
  const call=(path:string,body?:unknown,method=body?'PUT':'GET')=>app.call(path,member,{method,body});
  let p=await(await call('/api/apps/workshop/projects',{example:'cube'},'POST')).json() as any;
  const url=`/api/apps/workshop/projects/${p.id}/preview`;
  assert.equal((await call(url)).status,404);
  const input={appPackageHash:'a'.repeat(64),revision:p.revision,capturedAt:new Date().toISOString(),renderer:'test fixture',images:['preview','desktop','mobile'].map(kind=>({kind,base64:png,width:1,height:1}))};
  assert.equal((await call(url,{...input,images:input.images.map(i=>({...i,width:2}))})).status,400);
  assert.equal((await app.call(url,undefined,{method:'PUT',body:input})).status,401);
  const upload=await call(url,input);assert.equal(upload.status,200,await upload.clone().text());
  const evidence=await upload.json() as any;assert.equal(evidence.artifacts.length,3);assert.match(evidence.artifacts[0].contentHash,/^[a-f0-9]{64}$/);
  const image=await call(url+`?revision=${p.revision}`);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.match(image.headers.get('cache-control')!,/private/);assert.deepEqual(Buffer.from(await image.arrayBuffer()),Buffer.from(png,'base64'));
  const again=await call(url,input);assert.deepEqual(await again.json(),evidence);
  assert.equal((await app.call(url,undefined,{method:'GET'})).status,401);
  const refreshed=await call(url,{...input,appPackageHash:'b'.repeat(64)});assert.equal((await refreshed.json() as any).appPackageHash,'b'.repeat(64));
  const current=await(await call(`/api/apps/workshop/projects/${p.id}`)).json() as any;assert.equal(current.revision,p.revision);
  const old=p.revision;p=await(await call(`/api/apps/workshop/projects/${p.id}`,{...p,name:'New revision'})).json();
  assert.equal((await call(url)).status,404);assert.equal((await call(url+`?revision=${old}`)).status,200);assert.equal((await call(url,input)).status,409);
 }finally{await app.dispose();}
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { appArtifact } from '@ai-outfitter/app-test/prepare';
import { appWorker } from '@ai-outfitter/app-test/worker';
const member={userId:'builder',organizationId:'fixture-org',role:'member'};
test('workspace results verify artifacts, preserve stale results and refuse immutable edits',async()=>{
 let requestRecord:Record<string,unknown>={};
 const runId='11111111-1111-4111-8111-111111111111';
 const app=await appWorker('workshop',appArtifact(new URL('..',import.meta.url),'operational'),'workspace-test',{workflowHost:()=>({call:async()=>({ok:true,value:{run:{id:runId,workflowId:'workshop-workspace',status:'complete',createdBy:'builder',createdAt:0,updatedAt:0},inputs:{'design.inputs.request':requestRecord},outputs:{'validate.outputs.result':{complete:true,value:{passed:true,candidate:{headSha:'a'.repeat(40)}}}},readiness:{run:'complete',steps:{}},attempts:[]}})})});
 const workflowHost={organizationId:'fixture-org',installationId:app.installationId,userId:'builder',packageHash:'fixture',phase:'interactive' as const,expiresAt:Date.now()+60000};
 try{
 const call=async(path:string,body:unknown,method='POST')=>{const r=await app.call(path,member,{method,body,workflowHost}); if(r.status>=500||r.status===301||r.status===302||r.status===303)console.error(method,path,r.status,await r.clone().text());return r;};
 let p=await (await call('/api/apps/workshop/projects',{example:'cube'})).json() as any;
 const url=`/api/apps/workshop/projects/${p.id}/builds`;
 p=await(await call(url,{id:p.id,revision:p.revision,repository:'example/fixture',sourceCommit:'a'.repeat(40),instructions:'Build test bracket',parameters:{},runner:'container:test'})).json() as any;
 const build=p.workspace.requests[0];
 requestRecord={projectId:p.id,buildId:build.id,repository:build.repository,sourceDir:build.sourceDir,sourceCommit:build.sourceCommit,parameters:build.parameters};
 const claim={id:p.id,revision:p.revision,buildId:build.id,workflowRunId:runId};p=await(await call(url+'?action=claim',claim)).json();
 assert.equal((await call(url+'?action=claim',claim)).status,409);
 const bytes=Buffer.from('source fixture');const hash=createHash('sha256').update(bytes).digest('hex');const path=hash+'/source.tar';
 const manifest={version:1,units:'mm',sourceCommit:'a'.repeat(40),sourceHash:hash,compiler:'fixture',runner:'container:test',parameters:{},assembly:{items:[]},artifacts:[{path,sha256:hash,bytes:bytes.length,contentType:'text/plain'}],tests:[],notes:'',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()};
 assert.equal((await call(url+'?action=finish',{id:p.id,revision:p.revision,buildId:build.id,manifest})).status,400);
 assert.equal((await call(url,{buildId:build.id,path,base64:bytes.toString('base64'),contentType:'text/plain'},'PUT')).status,200);
 // An unrelated edit makes the old run historical instead of replacing current work.
 p=await(await call(`/api/apps/workshop/projects/${p.id}`,{...p,name:'Edited while building'},'PUT')).json();
 p=await(await call(url+'?action=finish',{id:p.id,revision:p.revision,buildId:build.id,manifest})).json();
 assert.equal(p.workspace.requests[0].result.stale,true);assert.equal(p.workspace.currentBuildId,undefined);
 assert.equal((await call(url,{buildId:build.id,path,base64:bytes.toString('base64'),contentType:'text/plain'},'PUT')).status,409);
 assert.equal((await call(`/api/apps/workshop/projects/${p.id}`,{...p,workspace:{...p.workspace,requests:[]}},'PUT')).status,400);
 p=await(await call(url,{id:p.id,revision:p.revision,repository:'example/fixture',sourceCommit:'a'.repeat(40),instructions:'Build current revision',parameters:{},runner:'container:test'})).json() as any;
 const current=p.workspace.requests.at(-1);
 requestRecord={projectId:p.id,buildId:current.id,repository:current.repository,sourceDir:current.sourceDir,sourceCommit:current.sourceCommit,parameters:current.parameters};
 p=await(await call(url+'?action=claim',{id:p.id,revision:p.revision,buildId:current.id,workflowRunId:runId})).json();
 assert.equal((await call(url,{buildId:current.id,path,base64:bytes.toString('base64'),contentType:'text/plain'},'PUT')).status,200);
 p=await(await call(url+'?action=finish',{id:p.id,revision:p.revision,buildId:current.id,manifest})).json();
 assert.equal(p.workspace.currentBuildId,current.id);
 assert.equal(p.workspace.requests.at(-1).result.stale,false);

 }finally{await app.dispose();}
});

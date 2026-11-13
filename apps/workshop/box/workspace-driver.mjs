// App-specific coordinator inside the shared sealed box. Source and requests
// arrive through private mounts. Every design/build executes via the gateway.
import { readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync,cpSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { createClient } from '@libsql/client';
import { platformRequest,signIn } from './driver.mjs';
import { sessionFiles,readSession,mergedTranscript } from '../../../box/sessions.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function findManifests(path){if(!existsSync(path))return [];return readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?findManifests(join(path,e.name)):e.name==='manifest.json'?[join(path,e.name)]:[]);}
export async function waitForWorkflow(db,id,{timeoutMs=45*60*1000,pollMs=3000}={}){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  const rows=await db.execute({sql:'SELECT status FROM workflow_runs WHERE id=?',args:[id]});
  const state=String(rows.rows[0]?.status??'');
  if(['complete','failed','cancelled'].includes(state))return state;
  await pause(pollMs);
 }
 throw Error(`Workspace workflow ${id} timed out`);
}
export async function runWorkspace(box){
 const cookie=await signIn(box);
 const api=async(path,method='GET',body)=>{const r=await platformRequest(box,'workshop.box.outfitter.localhost',path,{method,body,cookie});if(r.status>=400)throw Error(`${method} ${path}: ${r.status} ${r.text.slice(0,500)}`);return JSON.parse(r.text);};
 const db=createClient({url:`file:${box.databases.platform}`});
 let initialFailure;
 async function execute(project,build){
  const base=`/api/apps/workshop/projects/${project.id}`,url=base+'/builds';let workflow,ownsClaim=false;
  try{
   if(build.workflowRunId){workflow={id:build.workflowRunId};ownsClaim=true;}
   else {
   await box.operator({operation:'configure',repository:build.repository,sourceDir:build.sourceDir,model:box.model.id});
   workflow={id:crypto.randomUUID()};
   project=await api(url+'?action=claim','POST',{id:project.id,revision:project.revision,buildId:build.id,workflowRunId:workflow.id});
   ownsClaim=true;
   await box.operator({operation:'start',projectId:project.id,buildId:build.id,workflowRunId:workflow.id,repository:build.repository,sourceDir:build.sourceDir,sourceCommit:build.sourceCommit,instructions:build.instructions,parameters:build.parameters});
   }
   box.log(`Workspace workflow ${workflow.id} started for build ${build.id}`);
   const state=await waitForWorkflow(db,workflow.id);
   if(state!=='complete')throw Error(`Workspace workflow ${workflow.id}: ${state||'timed out'}`);
   const rows=await db.execute({sql:'SELECT value FROM workflow_run_slots WHERE runId=? AND slot=?',args:[workflow.id,'validate.outputs.result']});const validated=JSON.parse(String(rows.rows[0]?.value??'null'));
   if(!validated?.passed)throw Error('Workspace validation failed');
   const attempts=await db.execute({sql:"SELECT receipt FROM workflow_node_attempts WHERE runId=? AND nodeId='validate' ORDER BY updatedAt DESC LIMIT 1",args:[workflow.id]});
   const validator=JSON.parse(String(attempts.rows[0]?.receipt??'{}')).externalId;
   if(!/^[a-f0-9-]{36}$/.test(validator??''))throw Error('Validator workspace receipt is missing');
   const built=findManifests(box.workspaces).filter(p=>p.includes(`/ws-${validator}/files/evidence/`)).map(path=>({path,manifest:JSON.parse(readFileSync(path,'utf8'))})).filter(v=>v.manifest.sourceCommit===validated.candidate.headSha&&Date.parse(v.manifest.startedAt)>=Date.parse(build.createdAt)).sort((a,b)=>b.manifest.finishedAt.localeCompare(a.manifest.finishedAt))[0];
   if(!built)throw Error('Validator produced no matching artifact manifest');
   for(const artifact of built.manifest.artifacts)await api(url,'PUT',{buildId:build.id,path:artifact.path,contentType:artifact.contentType,base64:readFileSync(join(dirname(built.path),artifact.path)).toString('base64')});
   project=await api(base);
   project=await api(url+'?action=finish','POST',{id:project.id,revision:project.revision,buildId:build.id,manifest:built.manifest});
   const output=join(box.out,'results',build.id);mkdirSync(output,{recursive:true});cpSync(dirname(built.path),output,{recursive:true});writeFileSync(join(output,'project.json'),JSON.stringify(project,null,2));writeFileSync(join(output,'workflow.json'),JSON.stringify({id:workflow.id,status:state},null,2));
   box.log(`Published project ${project.id}, ${built.manifest.tests.length} checks`);
  }catch(error){
   initialFailure??=error;box.log(`Build ${build.id} failed: ${error.message}`);
   if(ownsClaim)try{
    project=await api(base);const current=project.workspace?.requests.find(r=>r.id===build.id);
    if(current?.status==='running'&&!current.result&&current.workflowRunId===workflow?.id)await api(url+'?action=finish','POST',{id:project.id,revision:project.revision,buildId:build.id,error:error.message});
   }catch(reportError){box.log(`Could not record build failure: ${reportError.message}`);}
  }
  finally {
   const output=join(box.out,'results',build.id);mkdirSync(output,{recursive:true});
   writeFileSync(join(output,'project.json'),JSON.stringify(project,null,2));
   if(workflow){
    const attempts=await db.execute({sql:'SELECT nodeId,state,receipt FROM workflow_node_attempts WHERE runId=?',args:[workflow.id]});
    const sessions=attempts.rows.flatMap(row=>{const receipt=JSON.parse(String(row.receipt??'{}'));return receipt.externalId?sessionFiles(box.workspaces,receipt.externalId).map(path=>({agent:String(row.nodeId),entries:readSession(path)})):[];});
    writeFileSync(join(output,'transcript.jsonl'),mergedTranscript(sessions));
    writeFileSync(join(output,'eval.json'),JSON.stringify({workflowId:workflow.id,buildId:build.id,model:box.model,sourceCommit:build.sourceCommit,parameters:build.parameters,status:project.workspace.requests.find(r=>r.id===build.id)?.status,nodes:attempts.rows.map(row=>({node:row.nodeId,state:row.state})),usage:sessions.flatMap(s=>s.entries.flatMap(e=>e.message?.usage?[{agent:s.agent,timestamp:e.timestamp,...e.message.usage}]:[]))},null,2));
   }
  }
 }
 try{
  for(const file of readdirSync(box.requests).filter(f=>f.endsWith('.json'))){
   const request=JSON.parse(readFileSync(join(box.requests,file),'utf8'));
   const all=await api('/api/apps/workshop/projects');
   let project=all.find(p=>p.name===request.title);
   if(project){project=await api(`/api/apps/workshop/projects/${project.id}`);if(project.workspace?.requests.length)continue;}
   else project=await api('/api/apps/workshop/projects','POST',{example:'cube',name:request.title});
   project=await api(`/api/apps/workshop/projects/${project.id}/builds`,'POST',{id:project.id,revision:project.revision,repository:box.repository,sourceDir:request.workspace.sourceDir,sourceCommit:request.workspace.sourceCommit,instructions:request.message,parameters:request.workspace.parameters??{},runner:'workspace-box'});
   await execute(project,project.workspace.requests.at(-1));
  }
  await box.finish(initialFailure);
  // The inspection box stays useful: UI/MCP parameter requests are consumed by
  // the same coordinator. An eval with BOX_EXIT_WHEN_DONE exits above.
  while(!box.env.BOX_EXIT_WHEN_DONE){
   for(const row of await api('/api/apps/workshop/projects')){
    const project=await api(`/api/apps/workshop/projects/${row.id}`);
    if(project.workspace?.repository!==box.repository)continue;
    const queued=project.workspace.requests.find(r=>['queued','running'].includes(r.status));if(queued)await execute(project,queued);
   }
   await pause(3000);
  }
 }finally{db.close();}
}

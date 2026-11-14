import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BuildManifestSchema } from "../lib/workspace";
import { getWorkshopProject, updateWorkshopProject } from "./projects";
import type { WorkshopContext } from "./graphql";
const base={id:z.uuid(),revision:z.number().int().nonnegative()};
export const requestBuildInput=z.object({...base,repository:z.string().min(1).max(2000),sourceDir:z.string().max(300).default("."),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),instructions:z.string().min(1).max(5000),parameters:z.record(z.string(),z.union([z.number(),z.string(),z.boolean()])).default({}),runner:z.string().min(1).max(300)}).strict();
export const claimBuildInput=z.object({...base,buildId:z.uuid(),workflowRunId:z.uuid()}).strict();
export const finishBuildInput=z.object({...base,buildId:z.uuid(),manifest:BuildManifestSchema.optional(),error:z.string().min(1).max(5000).optional()}).strict().refine(i=>Boolean(i.manifest)!==Boolean(i.error),"Supply a manifest or an error");
const stale=()=>new Response("Project changed; reload and retry.",{status:409});
export async function requestBuild(c:WorkshopContext,i:z.output<typeof requestBuildInput>){
 const p=await getWorkshopProject(c.db(),i.id);if(p.revision!==i.revision)throw stale();
 if(p.workspace?.requests.some(r=>r.status==="queued"||r.status==="running"))throw new Response("A build is already queued or running",{status:409});
 const workspace=p.workspace??{repository:i.repository,sourceDir:i.sourceDir,requests:[]};
 if(workspace.requests.length>=100)throw new Response("Project run limit reached; export before starting another project.",{status:409});
 return updateWorkshopProject(c.db(),c.identity,{...p,workspace:{...workspace,repository:i.repository,sourceDir:i.sourceDir,requests:[...workspace.requests,{id:crypto.randomUUID(),repository:i.repository,sourceDir:i.sourceDir,baseRevision:p.revision,sourceCommit:i.sourceCommit,instructions:i.instructions,parameters:i.parameters,runner:i.runner,createdAt:new Date().toISOString(),status:"queued"}]}},p.id,true);
}
export async function claimBuild(c:WorkshopContext,i:z.output<typeof claimBuildInput>){
 const p=await getWorkshopProject(c.db(),i.id);if(p.revision!==i.revision)throw stale();
 const w=p.workspace,r=w?.requests.find(r=>r.id===i.buildId);if(!w||!r||r.status!=="queued")throw new Response("Build is not queued",{status:409});
 return updateWorkshopProject(c.db(),c.identity,{...p,workspace:{...w,requests:w.requests.map(r=>r.id===i.buildId?{...r,status:"running",...(i.workflowRunId?{workflowRunId:i.workflowRunId}:{})}:r)}},p.id,true);
}
export const artifactKey=(project:string,build:string,path:string)=>`${project}/${build}/${path}`;
export async function finishBuild(c:WorkshopContext,i:z.output<typeof finishBuildInput>){
 const p=await getWorkshopProject(c.db(),i.id);if(p.revision!==i.revision)throw stale();
 const w=p.workspace,r=w?.requests.find(r=>r.id===i.buildId);if(!w||!r||r.status!=="running"||r.result)throw new Response("Unknown or completed build",{status:409});
 if(i.manifest){
  if(!r.workflowRunId)throw new Response("A validated workflow is required",{status:409});
  const workflow=await c.host().call("workflow.read",{id:r.workflowRunId});
  const requested=workflow?.inputs["design.inputs.request"] as Record<string,unknown>|undefined;
  const same=(a:unknown,b:unknown)=>JSON.stringify(a,Object.keys((a??{}) as object).sort())===JSON.stringify(b,Object.keys((b??{}) as object).sort());
  if(workflow?.run.workflowId!=="workshop-workspace"||workflow.run.status!=="complete"||!requested||requested.projectId!==p.id||requested.buildId!==r.id||requested.sourceCommit!==r.sourceCommit||requested.repository!==r.repository||requested.sourceDir!==r.sourceDir||!same(requested.parameters,r.parameters))throw new Response("Workflow does not match this build",{status:409});
  const validated=workflow.outputs["validate.outputs.result"];
  const result=validated?.value as {candidate?:{headSha?:string};passed?:boolean}|undefined;
  if(!validated?.complete||!result?.passed||!result.candidate?.headSha)throw new Response("Workspace validation is incomplete",{status:409});
  const expectedCommit=result.candidate.headSha;
  if(i.manifest.sourceCommit!==expectedCommit)throw new Response("Source commit mismatch",{status:400});
  for(const [key,value] of Object.entries(r.parameters))if(i.manifest.parameters[key]!==value)throw new Response("Parameter mismatch",{status:400});
  for(const a of i.manifest.artifacts){
   const f=await c.storage().get({space:"builds",key:artifactKey(p.id,r.id,a.path)});
   if(!f)throw new Response(`Missing artifact ${a.path}`,{status:400});
   const bytes=new Uint8Array(await new Response(f.body).arrayBuffer());
   if(bytes.length!==a.bytes||bytesToHex(sha256(bytes))!==a.sha256)throw new Response(`Artifact mismatch ${a.path}`,{status:400});
  }
 }
 // A result may be attached to its original request, but a newer request/edit prevents promotion.
 const isStale=p.revision!==r.baseRevision+2;
 const success=Boolean(i.manifest)&&!i.manifest!.tests.some(t=>t.status==="fail");
 const result={...(i.manifest?{manifest:i.manifest}:{}),...(i.error?{error:i.error}:{}),artifactBase:`/files/main/builds/${p.id}/${r.id}/`,stale:isStale};
 return updateWorkshopProject(c.db(),c.identity,{...p,...(success&&!isStale?{assembly:i.manifest!.assembly}:{}),workspace:{...w,...(success&&!isStale?{currentBuildId:r.id}:{}),requests:w.requests.map(v=>v.id===r.id?{...v,status:success?"succeeded":"failed",result}:v)}},p.id,true);
}

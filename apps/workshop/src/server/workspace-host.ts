import { z } from "zod";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import { workflowPhaseHandler, prepareInput, finalizeInput, type WorkflowHost, type WorkflowPhaseHandlers } from "@ai-outfitter/app-sdk/workflow-host";
const workflow="workshop-workspace";
const repository=z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
const sourceDir=z.string().regex(/^[A-Za-z0-9_./-]+$/).refine(s=>!s.startsWith("/")&&!s.split('/').includes('..'));
const configure=z.object({operation:z.literal("configure"),repository,sourceDir,model:z.string().default("gpt-6-luna")});
const start=z.object({operation:z.literal("start"),projectId:z.uuid(),buildId:z.uuid(),workflowRunId:z.uuid(),repository,sourceDir,sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),instructions:z.string().max(5000),parameters:z.record(z.string(),z.union([z.string(),z.number(),z.boolean()])).default({})});
async function operator(raw:unknown,host:WorkflowHost<"operator">){
 const input=z.union([configure,start]).parse(raw);const snap=await host.call("snapshot",{});
 const connections=snap.connections.filter(c=>["github","forgejo"].includes(c.provider)&&c.repositories.some(r=>r.toLowerCase()===input.repository.toLowerCase()));
 if(connections.length!==1)throw new Response("One connected repository is required",{status:409});
 const meta=z.object({id:z.number(),full_name:z.string()}).parse(await host.call("repository.request",{connectionId:connections[0].id,path:`/repos/${input.repository}`}));
 if(input.operation==="configure"){
  const bindings:Record<string,string>={};
  for(const [actor,role] of [["designer","design"],["validator","validate"]]){
   const systemPrompt="Build and test only the assigned hardware project in its workspace. Keep source in the project repository. Record actual tool results and unresolved physical acceptance.";
   const binding=await host.call("binding.approve",{workflowId:workflow,actor,label:`Workshop ${role}: ${input.sourceDir}`,workspace:{resource:String(meta.id),repository:meta.full_name,agentPermissions:{contents:role==="design"?"write":"read",...(role==="design"?{pull_requests:"write" as const}:{})},coordinatorPermissions:{contents:"read"},settings:{role,sourceDir:input.sourceDir}},context:{model:input.model,profile:{id:`workshop-${role}`,digest:await sha256Hex(systemPrompt),systemPrompt},capabilities:[]}});
   bindings[actor]=binding.id;
  }
  return {repository:meta.full_name,bindings};
 }
 const ids:Record<string,string>={};
 for(const actor of ["designer","validator"]){
  for(const b of snap.bindings.filter(b=>b.workflowId===workflow&&b.actor===actor&&b.enabled&&b.packageHash===snap.installation.activeHash&&b.label===`Workshop ${actor==="designer"?"design":"validate"}: ${input.sourceDir}`)){
   const repo=await host.call("repository.read",{bindingId:b.id});if(String(repo.repositoryId)===String(meta.id))ids[actor]=b.id;
  }
  if(!ids[actor])throw new Response("Configure Workshop workspace bindings first",{status:409});
 }
 return host.call("workflow.start",{workflow,id:input.workflowRunId,inputs:{"design.inputs.designerBinding":ids.designer,"design.inputs.validatorBinding":ids.validator,"design.inputs.request":JSON.parse(JSON.stringify(input))}});
}
/** The workspace phases, with the phases the caller adds (the design task's interactive phase). */
export const workspacePhases=(extra:WorkflowPhaseHandlers={})=>workflowPhaseHandler({
 ...extra,
 operator:(input,host)=>operator(input,host),
 prepare:async raw=>{
  const {settings,inputs}=prepareInput.parse(raw);const policy=z.object({role:z.enum(["design","validate"]),sourceDir}).parse(settings);
  const req=z.object({sourceDir,parameters:z.record(z.string(),z.union([z.string(),z.number(),z.boolean()])).default({})}).parse(inputs.request);
  if(req.sourceDir!==policy.sourceDir)throw new Response("Source directory mismatch",{status:403});
  return {mode:"agent" as const,role:policy.role,checks:policy.role==="validate"?[{name:"workspace-cad",commands:[["python3","/opt/workshop/build.py",policy.sourceDir,"../evidence","--parameters",JSON.stringify(req.parameters)]]}]:[],guidance:[`Project source directory: ${policy.sourceDir}. Build with python3 /opt/workshop/build.py ${policy.sourceDir} ../evidence. Commit source before the final build. The validator rebuilds your candidate commit independently.`]};
 },
 finalize:async(raw,host):Promise<Record<string,z.core.util.JSONType>>=>{
  const i=finalizeInput.parse(raw);
  const policy=z.object({role:z.enum(["design","validate"]),sourceDir}).parse(i.settings);
  const previous=z.record(z.string(),z.unknown()).parse(i.inputs.previous??{});
  const produced=z.record(z.string(),z.unknown()).parse(i.outputs.result??{});
  const candidate=z.object({headSha:z.string().regex(/^[a-f0-9]{40}$/)}).parse(policy.role==="validate"?previous.candidate:produced.candidate);
  const repo=await host.call("repository.read",{});
  const commit=z.object({sha:z.string()}).parse(await host.call("repository.request",{path:`/repos/${repo.name}/commits/${candidate.headSha}`}));
  if(commit.sha!==candidate.headSha)throw new Response("Candidate commit mismatch",{status:403});
  if(policy.role==="design")return {outputs:{result:{candidate,sourceDir:policy.sourceDir,summary:String(produced.summary??"").slice(0,2000),sessionArtifact:i.session.artifact??null}}};
  const checks=z.array(z.object({name:z.string(),headSha:z.string(),passed:z.boolean()})).parse(produced.checks);
  if(checks.length!==1||checks[0].name!=="workspace-cad"||checks[0].headSha!==candidate.headSha)throw new Response("Validation does not match approved commands",{status:403});
  return {outputs:{result:{candidate,checks,passed:checks.every(c=>c.passed),sessionArtifact:i.session.artifact??null}}};
 },
});

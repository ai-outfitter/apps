import {strictStructuredResult} from "@ai-outfitter/app-sdk/structured-result";
import type {OperationInput,WorkflowHost} from "@ai-outfitter/app-sdk/workflow-host";
import {inferenceRequest} from "@ai-outfitter/app-sdk/workflow-inference";
import {type ReplayOverrides, type SessionEntry,sessionEntry,type WorkflowReplayAdapter,type WorkflowSession,workflowSession} from "@ai-outfitter/app-sdk/workflow-session";
import {createOpenAI} from "@ai-sdk/openai";
import {generateText,NoObjectGeneratedError, Output} from "ai";
import {z} from "zod";
import type {AnalysisInput} from "../../src/server/analysis-batches";
import type {DiscoveryOntology} from "../../src/server/discovery-ontology";
import {type Graph,type Sample, semanticProposal} from "../../src/server/semantic-discovery";

type Inference = (request:ReturnType<typeof inferenceRequest>,model:string) => Promise<{output:unknown;text?:string;finishReason?:string;usage?:unknown}>;
type Settings=Parameters<typeof inferenceRequest>[3];
type Context={adapter:string;graph:Graph;samples:Sample[];ontology:DiscoveryOntology;user:{id:string;name:string;email:string};instructions:string;selection?:unknown};
const json=(value:unknown)=>z.json().parse(JSON.parse(JSON.stringify(value)));

function replayContext(original:WorkflowSession,checkpointId:string,overrides:ReplayOverrides){
  workflowSession.parse(original);
  const checkpoint=original.entries.find(e=>e.id===checkpointId&&e.kind==='checkpoint');
  const root=original.entries.find(e=>e.id==='analysis'&&e.kind==='checkpoint');
  if(!root||!checkpoint)throw new Error('Unsupported replay: exact analysis context was not captured. Capture a new run.');
  const context=root.data as unknown as Context;
  if(context.adapter!=='forerunner-analysis-v1'||!context.graph||!context.samples||!context.ontology||!context.user)throw new Error('Unsupported replay: missing source, graph, ontology or identity context.');
  const onlyBatch=checkpointId==='analysis'?undefined:(checkpoint.data as {batch?:number}).batch;
  if(checkpointId!=='analysis'&&!Number.isInteger(onlyBatch))throw new Error('Unsupported replay checkpoint');
  if(onlyBatch!==undefined&&overrides.batchBudget!==undefined)throw new Error('Change batching from the analysis checkpoint; a selected batch keeps its original inputs.');
  return {context,onlyBatch};
}
function replaySettings(original:WorkflowSession,checkpointId:string,overrides:ReplayOverrides){
  const firstCall=original.entries.find(e=>e.kind==='inference-start'&&(checkpointId==='analysis'||e.parentId===checkpointId));
  const recorded=firstCall?.data as {model?:string;settings?:Settings}|undefined;
  if(!recorded?.settings||!recorded.model)throw new Error('Unsupported replay: resolved model settings were not captured.');
  const settings={...recorded.settings};
  if(overrides.maxOutputTokens!==undefined)settings.maxOutputTokens=z.number().int().positive().parse(overrides.maxOutputTokens);
  if(overrides.timeoutMs!==undefined)settings.timeoutMs=z.number().int().positive().parse(overrides.timeoutMs);
  return {settings,model:overrides.model??recorded.model};
}
function recordedBatches(original:WorkflowSession){
  return original.entries.filter(e=>e.kind==='checkpoint'&&e.id.startsWith('analysis.batch.'))
    .sort((a,b)=>(a.data as {batch:number}).batch-(b.data as {batch:number}).batch)
    .map(e=>(e.data as {data:AnalysisInput}).data);
}
async function generate(entries:SessionEntry[],input:OperationInput<'inference.generate'>,settings:Settings,model:string,infer:Inference){
  const id=crypto.randomUUID();
  const request=inferenceRequest(input.instructions,input.data,input.schema,settings);
  entries.push({id,parentId:input.checkpointId??'analysis',kind:'inference-start',step:'analyze',at:new Date().toISOString(),data:json({...request,model})});
  const base={id:`${id}.result`,parentId:id,kind:'inference-result' as const,step:'analyze'};
  try{
    const result=await infer(request,model);
    entries.push({...base,at:new Date().toISOString(),data:json(result)});return {output:result.output};
  }catch(error){
    const failure={error:error instanceof Error?error.message:'Inference failed',...(NoObjectGeneratedError.isInstance(error)?{text:error.text,finishReason:error.finishReason,usage:error.usage}:{})};
    entries.push({...base,at:new Date().toISOString(),data:json(failure)});throw error;
  }
}
/** Only inference is live. A replay has no connector, document mutation or Wiki host. */
function localHost(entries:SessionEntry[],settings:Settings,model:string,infer:Inference):WorkflowHost<'interactive'>{
  return {call:async(operation:string,input:unknown)=>{
    if(operation==='session.append'){
      const entry=sessionEntry.parse((input as {entry:unknown}).entry);entries.push(entry);return {id:entry.id};
    }
    if(operation==='inference.generate')return generate(entries,input as OperationInput<'inference.generate'>,settings,model,infer);
    throw new Error(`Replay refuses external operation: ${operation}`);
  }} as WorkflowHost<'interactive'>;
}
async function runReplay(original:WorkflowSession,checkpointId:string,overrides:ReplayOverrides,infer:Inference){
  const {context,onlyBatch}=replayContext(original,checkpointId,overrides);
  const {settings,model}=replaySettings(original,checkpointId,overrides);
  const session:WorkflowSession={...structuredClone(original),exportedAt:new Date().toISOString(),entries:[],gaps:[],attempts:[],
    run:{...original.run,id:crypto.randomUUID(),status:'running',createdAt:Date.now(),updatedAt:Date.now()},
    branch:{sessionId:original.run.id,checkpointId,implementation:'local checkout',overrides:json(overrides)}};
  try{
    const output=await semanticProposal(localHost(session.entries,settings,model,infer),context.graph,context.samples,context.ontology,context.user,async()=>{},{
      taskId:session.run.id,selection:context.selection,instructions:overrides.instructions??context.instructions,batchBudget:overrides.batchBudget,onlyBatch,
      ...(onlyBatch!==undefined?{batches:recordedBatches(original)}:{}),
    });
    session.outputs=json(output);session.run.status='complete';return {session,output};
  }catch(error){
    session.run.status='failed';
    const message=error instanceof Response?await error.text():error instanceof Error?error.message:'Replay failed';
    session.outputs={error:message};return {session,output:session.outputs};
  }finally{session.run.updatedAt=Date.now();}
}
export function replayAdapter(infer:Inference):WorkflowReplayAdapter{
  return {id:'forerunner-analysis-v1',replay:(original,checkpointId,overrides)=>runReplay(original,checkpointId,overrides,infer)};
}
export const liveInference:Inference=async(request,model)=>{
  if(!process.env.WORKFLOW_EVAL_API_KEY||!process.env.WORKFLOW_EVAL_BASE_URL)throw new Error('Set WORKFLOW_EVAL_API_KEY and WORKFLOW_EVAL_BASE_URL for explicit local inference');
  const provider=createOpenAI({apiKey:process.env.WORKFLOW_EVAL_API_KEY,baseURL:process.env.WORKFLOW_EVAL_BASE_URL});
  const result=await generateText({model:request.settings.api==='responses'?provider.responses(model):provider.chat(model),system:request.system,messages:request.messages,
    output:Output.object({schema:z.fromJSONSchema(request.schema as never)}),maxOutputTokens:request.settings.maxOutputTokens,
    abortSignal:AbortSignal.timeout(request.settings.timeoutMs),maxRetries:1,
    providerOptions:{openai:{strictJsonSchema:strictStructuredResult(request.schema),...(request.settings.reasoningEffort?{reasoningEffort:request.settings.reasoningEffort as 'none'}:{})}}});
  return {output:result.output,text:result.text,finishReason:result.finishReason,usage:result.usage};
};

import assert from "node:assert/strict";
import {inferenceRequest} from "@ai-outfitter/app-sdk/workflow-inference";
import type {WorkflowSession} from "@ai-outfitter/app-sdk/workflow-session";
import {discoveryOntology} from "../../src/server/discovery-ontology";
import {semanticProposal} from "../../src/server/semantic-discovery";

const now="2026-11-05T12:00:00Z";
const typeId="10000000-0000-4000-8000-000000000001";
const graph={wiki:{installationId:"wiki",writable:true},types:[{ref:{installationId:"wiki",type:"graph-type",id:typeId},attributes:{id:typeId,name:"Person",category:"node",body:"A human individual."}},{ref:{id:"10000000-0000-4000-8000-000000000003"},attributes:{name:"corresponds_with",category:"edge",body:"A Person corresponds with another Person by direct email.\n\nFrom: Person\nTo: Person"}}],nodes:[],edges:[]} as unknown as Parameters<typeof discoveryOntology>[0];
const samples=[{provider:"gmail",account:"viewer@example.test",collectedAt:now,records:Array.from({length:40},(_,i)=>({id:`mail-${i}`,title:`Message ${i}`,text:`Bob wrote about a draft. ${"Full message content. ".repeat(160)}`,date:now,participants:["Bob"]}))}];
const user={id:"viewer",name:"Viewer",email:"viewer@example.test"};
export const answer=(request:any)=>({entities:[{key:"bob",name:"Bob",type:"Person",summary:"Wrote about a draft.",existingId:null,certainty:"mentioned",confidence:0.8,evidence:[request.data.evidence.find((e:any)=>e.ref!=="operating-user").ref]}],relationships:[]});
export async function capturedSession(){
 const entries:WorkflowSession['entries']=[];
 const host={call:async(op:string,input:any)=>{
  if(op==='workflow.start')return {id:"10000000-0000-4000-8000-000000000002"};
  if(op==='workflow.collect')return {};
  if(op==='session.append'){entries.push(input.entry);return {id:input.entry.id};}
  assert.equal(op,'inference.generate');const id=`call.${entries.length}`;
  const request=inferenceRequest(input.instructions,input.data,input.schema,{maxOutputTokens:16000,timeoutMs:300000,reasoningEffort:'none'});
  entries.push({id,parentId:input.checkpointId,kind:'inference-start',step:'analyze',at:now,data:JSON.parse(JSON.stringify({...request,model:'fixture-model'}))});
  const output=answer(request);entries.push({id:`${id}.result`,parentId:id,kind:'inference-result',step:'analyze',at:now,data:{output,finishReason:'stop'}});return {output};
 }} as Parameters<typeof semanticProposal>[0];
 const output=await semanticProposal(host,graph,samples,discoveryOntology(graph),user);
 return {format:'outfitter-workflow-session-v1',exportedAt:now,run:{id:'10000000-0000-4000-8000-000000000002',workflowId:'forerunner-discovery',createdBy:'viewer',installationId:'forerunner',organizationId:null,trigger:'manual',status:'complete',createdAt:1,updatedAt:2,definition:{},definitionHash:'fixture',packageHash:'fixture'},inputs:{},outputs:JSON.parse(JSON.stringify(output)),attempts:[],entries,gaps:[]} satisfies WorkflowSession;
}

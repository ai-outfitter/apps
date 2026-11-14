import assert from "node:assert/strict";
import type {WorkflowHost} from "@ai-outfitter/app-sdk/workflow-host";
/** Owner-scoped Wiki wire double; real revision/preservation behavior is covered by Wiki's store tests. */
export function reportHost(installationId="wiki",platformRead:()=>Promise<unknown>=async()=>({data:{dailyReports:[]}}),capturedAt=Date.now()){
 const pages=new Map<string,string>(),documents=new Map<string,{id:string;revision:number;generatedBody:string;body:string;archived:boolean}>();
 const calls:{operation:string;input:Record<string,any>}[]=[];
 const api={async call(operation:string,input:Record<string,any>){
  calls.push({operation,input});
  if(operation==="entities.types")return input.template==="onto"?["graph-type","graph-node","graph-edge"].map(type=>({type,installationId,template:"onto",writable:true})):[];
  if(operation==="actions.list")return [{installationId,actions:[{name:"graph.describe",access:"read",permitted:true}]}];
  if(operation==="actions.call"){
   assert.equal(input.installationId,installationId,"a report writes only its scoped Wiki");
   if(input.action==="graph.query")return {version:1,installationId,nodes:[],edges:[],types:[],complete:true,queries:Object.fromEntries(input.input.queries.map((q:any)=>[q.name,{entity:q.entity,total:0,matches:[],related:[],omitted:[],unresolved:[],missingTypes:[],complete:true,cursor:null}]))};
   if(input.action==="graph.describe")return {version:1,contracts:[{id:"outfitter.wiki-documents",version:1}],capabilities:["documents.read","documents.write"],types:[],queryAction:"graph.graphql"};
   if(input.input.query.includes("PersonalGoalContext"))return {data:{goals:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}};
   const variables=input.input.variables;
   if(input.action==="graph.graphql")return variables.slug?{data:{page:pages.has(variables.slug)?{documentId:pages.get(variables.slug)}:null}}:{data:{document:documents.get(variables.id)}};
   const value=variables.input;
   if(input.input.query.includes("SaveGeneratedDocument")){
          if(value.slug){
           const id=crypto.randomUUID();pages.set(value.slug,id);documents.set(id,{id,revision:1,generatedBody:value.generatedBody,body:"",archived:false});
           return {data:{saveGeneratedDocument:{id,revision:1,publishedRevision:null}}};
          }
    const doc=documents.get(value.id)!;assert.equal(value.revision,doc.revision);
    doc.generatedBody=value.generatedBody;doc.revision++;
    return {data:{saveGeneratedDocument:{id:doc.id,revision:doc.revision,publishedRevision:null}}};
   }
   const id=crypto.randomUUID();pages.set(value.slug,id);documents.set(id,{id,revision:1,generatedBody:"",body:value.body,archived:false});
   return {data:{saveDocument:{id,revision:1,publishedRevision:null}}};
  }
  if(operation==="schedules")return [];
  if(operation==="platform.document")return platformRead();
  if(operation==="workflow.start")return {id:input.id,workflow:input.workflow,created:true};
  if(operation==="workflow.collect")return {run:{},steps:[]};
  if(operation==="task.start")return {id:input.id,task:input.task,created:true};
  if(operation==="workflow.read")return {run:{createdAt:capturedAt}};
  if(operation==="inference.generate")return {output:{headline:"Observed Planning changes",summary:"The structured Planning changes were captured."}};
  throw new Error(`Unexpected ${operation}`);
 }};
 return {host:api as unknown as WorkflowHost<"interactive">&WorkflowHost<"schedule">,calls,documents};
}

import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {createClient,type InValue} from "@libsql/client";
import {drizzle} from "drizzle-orm/libsql";
import {migrate} from "drizzle-orm/libsql/migrator";
import {MockLanguageModelV3,simulateReadableStream} from "ai/test";
import {appWorker} from "@ai-outfitter/app-test/worker";
import {threadTestHost} from "@ai-outfitter/app-test/threads";
import {workflowHost,type WorkflowHostStub} from "@ai-outfitter/app-sdk/workflow-host";
import type {Thread} from "@ai-outfitter/app-sdk/threads";
import type {EntityRecord} from "@ai-outfitter/app-sdk/entities";
import {planningConversations,planningThreadTypes,conversationType,projectContext} from "../src/server/conversations";
import {createProject} from "../src/server/planning";
import {saveReportNote} from "../src/server/digest-wiki";
import {previousReportPeriod} from "../src/server/report-period";
const member={userId:"editor",organizationId:"org",role:"owner"};
const identity={...member,installationId:"planning",owner:{kind:"organization" as const,id:"org"},canEdit:true};

test("real Wiki entity snapshots reach each thread reply while authored transcript and late entries remain intact",async()=>{
 const wiki=await appWorker("wiki-map",new URL("../../wiki/.outfitter/packages/operational.json",import.meta.url),"wiki");
 const client=createClient({url:":memory:"}),db=drizzle(client);
 let threads:Awaited<ReturnType<typeof threadTestHost>>|undefined;
 try{
  await migrate(db,{migrationsFolder:fileURLToPath(new URL("../migrations",import.meta.url))});
  const project=await createProject(db,identity,{name:"Project fixture",goals:"Current project goal",userStories:""});
  const raw={query:async(input:{sql:string;params?:unknown[]})=>(await client.execute({sql:input.sql,args:(input.params??[]) as InValue[]})).rows as Record<string,unknown>[],batch:async(inputs:{sql:string;params?:unknown[]}[])=>client.batch(inputs.map(input=>({sql:input.sql,args:(input.params??[]) as InValue[]})),"write")};
  const stub:WorkflowHostStub={async call(operation,input){
   if(operation.startsWith("threads."))return threads!.stub({userId:member.userId,organizationId:"org",installationId:"planning"}).call(operation,input);
   if(operation==="schedules")return {ok:true,value:[]};
   if(operation==="actions.list"){
    const response=await wiki.call("/api/internal/actions/v1/list",member);
    assert.equal(response.status,200,await response.clone().text());
    return {ok:true,value:[{installationId:"wiki",actions:await response.json()}]};
   }
   if(operation==="actions.call"){
    const request=input as {installationId:string;action:string;input:unknown};assert.equal(request.installationId,"wiki");
    const response=await wiki.call("/api/internal/actions/v1/call",member,{method:"POST",body:{action:request.action,input:request.input,...((input as {readOnly?:boolean}).readOnly?{access:"read"}:{})}});
    if(!response.ok)return {ok:false,status:response.status,message:await response.text()};
    return {ok:true,value:await response.json()};
   }
   throw new Error(`Unexpected ${operation}`);
  }};
  const host=workflowHost<"interactive">({props:{workflowHost:stub}});
  const period=previousReportPeriod(Date.now());
  const note=(summary:string)=>saveReportNote(host,identity,{level:"project",subject:project.id,title:"Daily note",period,status:"complete",runId:"fixture-run",capturedAt:Date.now(),content:{summary,coverage:"Planning records only; no conversation messages were read."}});
  const firstNote=await note("WIKI-SOURCE-FIRST-REVISION");
  const prompts:string[]=[],loaded:number[]=[];
  threads=await threadTestHost({users:[member.userId],organizations:["org"],installations:["planning"],model:()=>new MockLanguageModelV3({doStream:async options=>{
   prompts.push(JSON.stringify(options.prompt));
   return {stream:simulateReadableStream({chunks:[{type:"text-start",id:"text"},{type:"text-delta",id:"text",delta:"Recorded reply."},{type:"text-end",id:"text"},{type:"finish",finishReason:{unified:"stop",raw:"stop"},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}}}]})};
  }}),source:async(principal,source,thread)=>{
   assert.equal(principal.organizationId,"org");assert.equal(thread.owner.kind,"organization");
   assert.equal(source.installationId,"wiki");assert.equal(source.type,"document");
   const response=await wiki.call("/api/internal/entities/v1/get",member,{method:"POST",body:{type:source.type,id:source.id}});
   assert.equal(response.status,200,await response.clone().text());
   const record=await response.json() as EntityRecord;
   assert.equal(record.revision,source.revision,"the resolver refuses a stale revision rather than substitute content");
   loaded.push(record.revision);return record;
  },provider:async({operation,input})=>{
   const provider=planningConversations(raw,identity,[member.userId],host);
   if(operation==="types")return planningThreadTypes;
   if(operation==="prepare")return provider.prepare(input as never);
   if(operation==="deleted")return provider.deleting(input as never);
   throw new Error(`Unexpected provider ${operation}`);
  }});
  const call=async<T>(operation:string,input:unknown)=>{const result=await threads!.stub({userId:member.userId,organizationId:"org",installationId:"planning"}).call(operation,input);if(!result.ok)throw new Error(`${operation}: ${result.status}: ${result.message}`);return result.value as T;};
  const thread=await call<Thread>("threads.create",{type:conversationType,title:"Project discussion",context:{type:projectContext,id:project.id}});
  await call("threads.append",{threadId:thread.id,sourceKey:"late-1",role:"event",parts:[{type:"text",text:"LATE-DETAIL-AFTER-DAILY-NOTE"}]});
  const send=async(text:string)=>{const submissionId=crypto.randomUUID();await call("threads.send",{threadId:thread.id,submissionId,text});await threads!.settle();const state=await call<{state:string}>("threads.submission",{threadId:thread.id,submissionId});assert.equal(state.state,"completed");};
  await send("First project question");
  assert.match(prompts[0],/WIKI-SOURCE-FIRST-REVISION/);assert.match(prompts[0],/LATE-DETAIL-AFTER-DAILY-NOTE/);
  const updated=await note("WIKI-SOURCE-UPDATED-REVISION");
  assert.equal(updated.revision,firstNote.revision+1);
  await call("threads.append",{threadId:thread.id,sourceKey:"late-2",role:"event",parts:[{type:"text",text:"SECOND-LATE-DETAIL"}]});
  await send("Second project question");
  assert.match(prompts[1],/WIKI-SOURCE-UPDATED-REVISION/);assert.doesNotMatch(prompts[1],/WIKI-SOURCE-FIRST-REVISION/);
  assert.match(prompts[1],/First project question/);assert.match(prompts[1],/LATE-DETAIL-AFTER-DAILY-NOTE/);assert.match(prompts[1],/SECOND-LATE-DETAIL/);
  assert.deepEqual(loaded,[firstNote.revision,updated.revision]);
  const saved=await call<{entries:unknown[]}>("threads.entries",{ref:{id:thread.id},limit:200});
  assert.match(JSON.stringify(saved),/SECOND-LATE-DETAIL/);assert.doesNotMatch(JSON.stringify(saved),/WIKI-SOURCE-/);
 }finally{threads?.client.close();client.close();await wiki.dispose();}
});

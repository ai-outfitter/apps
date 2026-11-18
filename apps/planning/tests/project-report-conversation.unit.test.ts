import assert from "node:assert/strict";
import test from "node:test";
import type {AppIdentity} from "@ai-outfitter/app-sdk/server";
import type {WorkflowHost} from "@ai-outfitter/app-sdk/workflow-host";
import {HISTORY_BUDGET} from "@ai-outfitter/app-sdk/threads";
import {planningConversations,previousProjectReportContext,conversationType,projectContext,intakeContext} from "../src/server/conversations";
import {saveReportNote} from "../src/server/digest-wiki";
import {configuredReportPeriod} from "../src/server/report-config";
import {previousReportPeriod} from "../src/server/report-period";
import {reportHost} from "./fixtures/report-host";
import {intakeFocus} from "../src/agent-focus";
const identity:AppIdentity={installationId:"planning",userId:"member",organizationId:"org",owner:{kind:"organization",id:"org"},role:"member",canEdit:false};
const projectId="11111111-1111-4111-8111-111111111111",at=Date.parse("2026-11-02T14:00:00Z");
async function fixture(){
 const base=reportHost("wiki");
 const host={call:async(operation:string,input:never)=>operation==="schedules"?[{workflowId:"project-digest",timezone:"America/Chicago",inputs:{timezone:"America/Chicago"}}]:base.host.call(operation as never,input)} as WorkflowHost<"interactive">;
 const period=previousReportPeriod(at);
 const note=await saveReportNote(host,identity,{level:"project",subject:projectId,title:"Daily fixture",period,content:{summary:"Previous day fixture",coverage:"Planning records only; history limited."},status:"complete",runId:"fixture-run",capturedAt:at});
 return {base,host,period,note};
}

test("previous local-day project source is owner scoped, revision pinned and transient in prepare",async()=>{
 const {host,note,period}=await fixture();
 const project={id:projectId,installationId:identity.installationId,name:"Canonical project",revision:3,goals:"Saved goals",userStories:"",githubRepository:"",pressRelease:"",demoInstructions:"",demoResults:""};
 const queries:string[]=[];
 const db={query:async(input:{sql:string;params?:unknown[]})=>{queries.push(input.sql);if(input.sql.startsWith("SELECT * FROM planning_projects")){assert.deepEqual(input.params,[projectId,identity.installationId]);return [project];}return [];},batch:async()=>{throw new Error("Preparing source context never writes app or thread records");}};
 const provider=planningConversations(db,identity,[],host);
 const thread={id:"22222222-2222-4222-8222-222222222222",type:conversationType,title:"Project chat",context:{type:projectContext,id:projectId},visibility:"private",parent:null} as never;
 const entry={id:"33333333-3333-4333-8333-333333333333",createdAt:at,metadata:null} as never;
 const prepared=await provider.prepare({thread,entry,submissionId:"submission",retry:false});
 assert.deepEqual(prepared.history,{budget:HISTORY_BUDGET,sources:[{installationId:"wiki",type:"document",id:note.documentId,revision:note.revision}]});
 const coverage=(prepared.context as {dailyProjectReport:{status:string;period:unknown;message:string}}).dailyProjectReport;
 assert.equal(coverage.status,"complete");
 assert.deepEqual(coverage.period,period);
 assert.match(coverage.message,/does not summarize or replace this conversation or any late messages/);
 assert.equal(queries.some(sql=>/DELETE|UPDATE|INSERT/.test(sql)),false);
 assert.equal("entries" in prepared.history!,false,"all saved and late entries remain owned by normal thread history");
});

test("missing, foreign scoped and unavailable reports preserve normal conversation context with explicit coverage",async()=>{
 const {host}=await fixture();
 const foreign=await previousProjectReportContext(host,{...identity,installationId:"other-planning",owner:{kind:"organization",id:"other-org"},organizationId:"other-org"},projectId,at);
 assert.equal(foreign.source,undefined);
 assert.equal(foreign.coverage.status,"missing");
 const noReport=await previousProjectReportContext(host,identity,"44444444-4444-4444-8444-444444444444",at);
 assert.equal(noReport.coverage.status,"missing");
 assert.equal(noReport.source,undefined);
 const unavailable=await previousProjectReportContext({call:async()=>{throw new Response("Wiki unavailable",{status:503});}} as unknown as WorkflowHost<"interactive">,identity,projectId,at);
 assert.equal(unavailable.coverage.status,"unavailable");
 assert.match(unavailable.coverage.message,/no report or transcript coverage is assumed/);
});

test("intake prepare never adopts an arbitrary project report",async()=>{
 const db={query:async()=>[],batch:async()=>{throw new Error("No writes");}};
 const host={call:async()=>{throw new Error("Intake must not load a project note");}} as unknown as WorkflowHost<"interactive">;
 const provider=planningConversations(db,identity,[],host);
 const result=await provider.prepare({thread:{id:"22222222-2222-4222-8222-222222222222",type:conversationType,title:"Intake",context:{type:intakeContext,id:intakeFocus.id},visibility:"private",parent:null} as never,entry:{id:"33333333-3333-4333-8333-333333333333",createdAt:at,metadata:null} as never,submissionId:"submission",retry:false});
 assert.deepEqual(result.history,{budget:HISTORY_BUDGET});
 assert.equal(Object.hasOwn(result.context as object??{},"dailyProjectReport"),false);
});


test("shared report period respects saved report timezone and does not guess on configuration outages",async()=>{
 const at=Date.parse("2026-11-02T02:00:00Z");
 const host={call:async()=>[{workflowId:"project-digest",timezone:"UTC",inputs:{timezone:"Asia/Tokyo"}}]} as unknown as WorkflowHost<"interactive">;
 assert.equal((await configuredReportPeriod(host,at)).date,"2026-11-01");
 assert.equal((await configuredReportPeriod(host,at)).timezone,"Asia/Tokyo");
 const unavailable={call:async()=>{throw new Response("Configuration unavailable",{status:503});}} as unknown as WorkflowHost<"interactive">;
 await assert.rejects(configuredReportPeriod(unavailable,at),error=>error instanceof Response && error.status===503);
});

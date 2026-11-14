import assert from "node:assert/strict";
import test from "node:test";
import {dailySummaryNodes} from "../src/server/home-cards";
import {saveReportNote} from "../src/server/digest-wiki";
import {previousReportPeriod} from "../src/server/report-period";
import {reportHost} from "./fixtures/report-host";
const identity={installationId:"planning",userId:"user",owner:{kind:"user",id:"user"},role:"owner",canEdit:true} as const;
const now=Date.parse("2026-11-10T14:00:00Z");
test("home reads the persisted personal daily overview and retains incomplete coverage",async()=>{
 const {host,calls}=reportHost();
 assert.match(JSON.stringify(await dailySummaryNodes(()=>host,identity,now)),/not available yet/);
 const ref=await saveReportNote(host,identity,{level:"personal",subject:"user",title:"Daily overview",period:previousReportPeriod(now),content:{summary:"One organization is missing"},status:"incomplete",runId:"run",capturedAt:now});
 calls.length=0;
 const nodes=await dailySummaryNodes(()=>host,identity,now);
 assert.deepEqual(nodes.at(-1),{kind:"link",label:"Read your daily overview",target:{installationId:ref.installationId,path:`/p/${ref.slug}?revision=${ref.revision}`}});
 assert.match(JSON.stringify(nodes),/Incomplete sources/);
 assert.ok(calls.every(call=>call.operation!=="inference.generate" && call.input.action!=="graph.mutate"));
});

test("a missing host leaves the existing project card usable",async()=>{
 assert.match(JSON.stringify(await dailySummaryNodes(()=>{throw new Error("Host unavailable");},identity,now)),/could not be read/);
});

test("home follows the saved report timezone across different local dates",async()=>{
 const {host}=reportHost();
 const call=host.call.bind(host) as (operation:string,input:Record<string,unknown>)=>Promise<unknown>;
 host.call=(async(op:string,input:any)=>op === "schedules" ? [{workflowId:"project-digest",timezone:"UTC",inputs:{timezone:"Asia/Tokyo"}}] : call(op,input)) as typeof host.call;
 const boundary=Date.parse("2026-11-10T02:00:00Z");
 await saveReportNote(host,identity,{level:"personal",subject:"user",title:"Tokyo overview",period:previousReportPeriod(boundary,"Asia/Tokyo"),content:{summary:"Local day capture"},status:"complete",runId:"run",capturedAt:boundary});
 assert.match(JSON.stringify(await dailySummaryNodes(()=>host,identity,boundary)),/2026-11-09 · Sources captured/);
});

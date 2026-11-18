import assert from "node:assert/strict";
import test from "node:test";
import {reportPreview} from "../src/server/report-preview";
import {saveReportNote,readDailyReport} from "../src/server/digest-wiki";
import {reportPeriodForDate} from "../src/server/report-period";
import {reportHost} from "./fixtures/report-host";
const actor={userId:"member",installationId:"planning",owner:{kind:"organization",id:"org"},organizationId:"org",role:"owner",canEdit:true} as const;
const repository={repository:"example/repo",path:null,ref:null,scope:"repository-wide",complete:true,unknowns:["A merge is not proof of deployment"],pullRequests:Array.from({length:31},(_,index)=>({number:index+1,title:`Observed change ${index}`,url:`https://github.com/example/repo/pull/${index+1}`,mergedAt:"2026-11-09T18:00:00Z"})),directCommits:[]};
const evidence={complete:true,errors:[],coverage:"Provider observations, not deployment",repositories:[repository]};
const input={level:"organization",subject:"org",title:"Daily report",period:reportPeriodForDate("2026-11-09"),status:"complete",runId:"run",capturedAt:1,content:{summary:"Fourteen projects",dependencies:Array.from({length:14},(_,index)=>({projectId:`project-${index}`,status:"complete",report:{installationId:"wiki",documentId:`document-${index}`,revision:3,slug:`project-${index}`},summary:{name:`Project ${index}`,counts:{issues:0},decisions:[],repositoryEvidence:evidence}}))}} as const;

test("large aggregate sources stay bounded with all exact child refs, counted omissions and stable atomic retry",async()=>{
 const f=reportHost(),saved=await saveReportNote(f.host,actor,input);
 const mutation=f.calls.filter(call=>call.operation==="actions.call"&&call.input.action==="graph.mutate");
 assert.equal(mutation.length,1);assert.match(mutation[0].input.input.query,/SaveGeneratedDocument/);
 assert.ok(Buffer.byteLength(JSON.stringify(mutation[0].input.input.variables))<=32768);
 const raw=await readDailyReport(f.host,actor,{date:input.period.date});
 const dependencies=raw!.dependencies as any[];
 assert.equal(dependencies.length,14);
 assert.deepEqual(dependencies.map(child=>[child.report.installationId,child.report.documentId,child.report.revision]),input.content.dependencies.map(child=>[child.report.installationId,child.report.documentId,child.report.revision]));
 assert.ok(dependencies.some(child=>child.summary.repositoryEvidence.repositories[0].omittedPullRequestCount>0));
 assert.match(JSON.stringify(raw),/not proof of deployment/);
 assert.equal((await saveReportNote(f.host,actor,input)).revision,saved.revision);
 assert.equal(f.calls.filter(call=>call.operation==="actions.call"&&call.input.action==="graph.mutate").length,1);
});

test("oversized source questions fail before creation; old empty shells recover without changing authored text",async()=>{
 const f=reportHost();
 await assert.rejects(saveReportNote(f.host,actor,{...input,content:{questions:"z".repeat(40000)}}),error=>error instanceof Response&&error.status===413);
 assert.equal(f.documents.size,0);assert.equal(f.calls.some(call=>call.input.action==="graph.mutate"),false);
 const saved=await saveReportNote(f.host,actor,input),doc=f.documents.get(saved.documentId)!;
 doc.generatedBody="";doc.body="Preserve authored correction";
 const recovered=await saveReportNote(f.host,actor,input);
 assert.equal(recovered.documentId,saved.documentId);assert.equal(recovered.revision,saved.revision+1);
 assert.equal(doc.body,"Preserve authored correction");
 assert.equal((await readDailyReport(f.host,actor,{date:input.period.date}))?.status,"complete");
});


test("personal previews keep exact organization lineage and stable incomplete/omitted project counts",()=>{
 const org=reportPreview(input.content,"organization") as any;
 org.dependencies[13].status="incomplete";
 const reference={installationId:"wiki",documentId:"org-doc",revision:2};
 const personal=reportPreview({organizations:[{organizationSlug:"org",owner:actor.owner,planningInstallationId:"planning",reference,status:"incomplete",dependencies:org.dependencies}]},"personal") as any;
 const source=personal.organizations[0];
 assert.deepEqual(source.reference,reference);assert.equal(source.status,"incomplete");
 assert.equal(source.projectSummaryCount,14);assert.equal(source.projectIncompleteCount,1);
 assert.equal(source.projectReferencesOmitted,11);assert.equal(source.dependencies.length,3);
 assert.equal(source.dependencies[0].summary.repositoryEvidence,undefined);
 const twice=(reportPreview(personal,"personal") as any).organizations[0];
 assert.equal(twice.projectIncompleteCount,1);assert.equal(twice.projectReferencesOmitted,11);
 assert.deepEqual(twice.reference,reference);
});

test("persisted personal previews retain federated source coordinates without a native installation ID",async()=>{
 const f=reportHost(),user={...actor,organizationId:undefined,owner:{kind:"user" as const,id:"member"}};
 const reference={app:"wiki-map",scope:"example-org",documentId:"organization-document",revision:4,slug:"organization-daily"};
 await saveReportNote(f.host,user,{...input,level:"personal",subject:"member",content:{organizations:[{organizationSlug:"example-org",status:"complete",reference,dependencies:[]}]}});
 const saved=await readDailyReport(f.host,user,{date:input.period.date});
 assert.deepEqual((saved!.organizations as any[])[0].reference,reference);
});

test("personal seven-organization overview with fourteen-project source and seven goals fits the transport bound",async()=>{
 const f=reportHost(),user={...actor,organizationId:undefined,owner:{kind:"user" as const,id:"member"}};
 const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
 const graphRef=(n:number,type="graph-node")=>({installationId:"local-00000000-0000-4000-8000-000000000001-onto",type,id:uuid(n),revision:2});
 const observation={status:"unknown",value:null,reason:"A metric definition describes a measurement method; no supported measurement value was read."};
 const goals=Array.from({length:7},(_,index)=>({title:`Personal goal ${index}`,body:"Authored goal context ".repeat(200),properties:{target:100},ref:graphRef(index+1),observation,
  metrics:[{title:`Metric definition ${index}`,body:"Calculation method ".repeat(200),calculation:"Not evaluated",ref:graphRef(index+11),relationship:graphRef(index+21,"graph-edge"),observation}]}));
 const organizations=[14,2,1,1,2,0,0].map((count,index)=>({organizationSlug:`example-${index}`,owner:{kind:"organization",id:uuid(index+100)},planningInstallationId:`local-${uuid(index+100)}-planning`,reference:{installationId:`local-${uuid(index+100)}-wiki-map`,documentId:uuid(index+200),revision:2,slug:`organization-daily-${uuid(index+300)}`},status:index===0?"incomplete":"complete",period:input.period,inputDigest:uuid(index+400),
  dependencies:Array.from({length:count},(_,child)=>({...input.content.dependencies[child%14],projectId:uuid(index*1000+child+500),report:{installationId:`local-${uuid(index+100)}-wiki-map`,documentId:uuid(index*1000+child+600),revision:2,slug:`project-daily-${uuid(index*1000+child+700)}`},summary:{...input.content.dependencies[child%14].summary,decisions:child===0?[{intakeId:uuid(index+800),revision:2,title:"Owning intake",questions:["Which customer outcome should this deliver?"]}]:[]}}))}));
 const content={summary:"Personal daily overview",organizations,personalProjects:[input.content.dependencies[0]],goalContext:{owner:user.owner,capturedAt:1,complete:true,errors:[],source:{installationId:graphRef(1).installationId,query:"Typed goal source query",digest:"digest"},references:goals.flatMap(goal=>[goal.ref,goal.metrics[0].ref,goal.metrics[0].relationship]),goals,completeness:{goalReads:"complete",history:"current-records-only",metricObservations:"unknown"},standup:{status:"unavailable",reason:"No standup evidence was read."}}};
 const saved=await saveReportNote(f.host,user,{...input,level:"personal",subject:"member",status:"incomplete",content});
 const mutation=f.calls.find(call=>call.input.action==="graph.mutate")!;
 assert.ok(Buffer.byteLength(JSON.stringify(mutation.input.input.variables))<=32768);
 const read=await readDailyReport(f.host,user,{date:input.period.date}) as any;
 assert.equal(read.organizations.length,7);assert.equal(read.organizations[0].dependencies.length,3);assert.equal(read.organizations[0].projectSummaryCount,14);assert.equal(read.organizations[0].projectReferencesOmitted,11);
 assert.equal(read.organizations[0].status,"incomplete");assert.deepEqual(read.organizations[0].reference,organizations[0].reference);
 assert.equal(read.organizations[0].dependencies[0].summary.decisions[0].questions[0],"Which customer outcome should this deliver?");
 assert.deepEqual(read.goalContext.references,content.goalContext.references);
 assert.equal(read.goalContext.goals.length,7);assert.deepEqual(read.goalContext.goals[0].observation,{status:"unknown",value:null});
 assert.ok(read.goalContext.references.some((ref:any)=>ref.id===goals[0].metrics[0].relationship.id));
 assert.equal(read.goalContext.goals[0].body,undefined);assert.equal(read.goalContext.standup.status,"unavailable");
 assert.equal((await saveReportNote(f.host,user,{...input,level:"personal",subject:"member",status:"incomplete",content})).revision,saved.revision);
});

test("personal compact references retain projects with truncated decision coverage even without a retained question",()=>{
 const dependencies=structuredClone(input.content.dependencies) as any[];
 dependencies[13].summary.decisionsTruncated=true;
 const preview=reportPreview({organizations:[{organizationSlug:"org",reference:{installationId:"wiki",documentId:"org",revision:1},status:"complete",dependencies}]},"personal") as any;
 assert.equal(preview.organizations[0].dependencies.length,4);
 assert.equal(preview.organizations[0].projectReferencesOmitted,10);
 assert.equal(preview.organizations[0].dependencies.at(-1).summary.decisionsTruncated,true);
});

test("organization previews retain completed issue observations and their coverage limits", () => {
 const preview=reportPreview({dependencies:[{projectId:"project",status:"complete",report:{documentId:"source",revision:2},summary:{name:"Project",completedIssues:[{id:"issue",title:"Review accepted",observedAt:123}],omittedIssueObservations:4}}]},"organization") as any;
 assert.deepEqual(preview.dependencies[0].summary.completedIssues,[{id:"issue",title:"Review accepted",observedAt:123}]);
 assert.equal(preview.dependencies[0].summary.omittedIssueObservations,4);
});

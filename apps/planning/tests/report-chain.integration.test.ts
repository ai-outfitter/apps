import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {createClient} from "@libsql/client";
import {drizzle} from "drizzle-orm/libsql";
import {migrate} from "drizzle-orm/libsql/migrator";
import {eq} from "drizzle-orm";
import type {AppIdentity} from "@ai-outfitter/app-sdk/server";
import * as planning from "../src/server/planning";
import {digests,issues,projects} from "../src/server/schema";
import {runReportChain} from "../src/server/report-chain";
import {readDailyReport} from "../src/server/digest-wiki";
import {previousReportPeriod} from "../src/server/report-period";
import {runDigestTask,startDailyReports} from "../src/server/digests";
import {savePersonalOverview} from "../src/server/personal-report";
import {reportHost} from "./fixtures/report-host";
const organization:AppIdentity={installationId:"planning-org",userId:"member",organizationId:"org",owner:{kind:"organization",id:"org"},role:"owner",canEdit:true};
const personal:AppIdentity={installationId:"planning-personal",userId:"member",owner:{kind:"user",id:"member"},role:"owner",canEdit:true};
const fields={name:"Launch",githubRepository:"",goals:"",userStories:"",pressRelease:"",demoInstructions:"",demoResults:""};
const now=Date.parse("2026-11-02T14:00:00Z");
async function setup(){const client=createClient({url:":memory:"}),db=drizzle(client);await migrate(db,{migrationsFolder:fileURLToPath(new URL("../migrations",import.meta.url))});return {client,db};}

test("calendar capture filters actual previous-day records, persists project then org, and revises changed generated input",async()=>{
 const {client,db}=await setup();try{
  const target=await planning.createProject(db,organization,fields),period=previousReportPeriod(now);
  const work=await planning.createIssue(db,organization,{projectId:target.id,title:"Yesterday work",description:"",category:"stone",status:"done",assigneeId:null,dueDate:null,parentId:null},[]);
  await db.update(projects).set({createdAt:period.start-100,updatedAt:period.start-100}).where(eq(projects.id,target.id));
  await db.update(issues).set({createdAt:period.start,updatedAt:period.end-1}).where(eq(issues.id,work.id));
  const {host,documents,calls}=reportHost();
  const first=await runReportChain(db,host,organization,[{...target,createdAt:period.start-100,updatedAt:period.start-100}],"run-1",{now});
  assert.equal(first.period.end-first.period.start,25*3600000,"fall-back day is 25 hours");
  assert.equal(first.status,"complete");
  const report=await readDailyReport(host,organization,{date:period.date});
  assert.ok(report);
  assert.equal(report.status,"complete");
  assert.deepEqual((report.dependencies as any[])[0].summary.completedIssues,[{id:work.id,title:"Yesterday work",observedAt:period.end-1}]);
  const projectRead=await readDailyReport(host,organization,{date:period.date,level:"project",subject:target.id});
  assert.match(JSON.stringify(projectRead),/Yesterday work/);
  assert.match(JSON.stringify(report),/"history":"limited"/);
  const generated=calls.filter(call=>call.input.input?.query?.includes("mutation SaveGeneratedDocument"));
  assert.equal(generated[0].input.input.variables.input.slug,first.projects[0].report?.slug);
  assert.equal(generated[1].input.input.variables.input.slug,first.overview?.slug);
  const unchanged=await runReportChain(db,host,organization,[{...target,createdAt:period.start-100,updatedAt:period.start-100}],"run-2",{now});
  assert.equal(unchanged.projects[0].report?.revision,first.projects[0].report?.revision);
  const projectDoc=documents.get(first.projects[0].report!.documentId)!;projectDoc.body="Keep authored notes";
  await db.update(issues).set({title:"Revised captured source",revision:2}).where(eq(issues.id,work.id));
  const changed=await runReportChain(db,host,organization,[{...target,createdAt:period.start-100,updatedAt:period.start-100}],"run-3",{now});
  assert.equal(changed.projects[0].report?.documentId,first.projects[0].report?.documentId);
  assert.equal(changed.projects[0].report?.revision,first.projects[0].report!.revision+1);
  assert.equal(projectDoc.body,"Keep authored notes");
  await db.update(issues).set({createdAt:period.start-1,updatedAt:period.end}).where(eq(issues.id,work.id));
  const outside=await runReportChain(db,host,organization,[{...target,createdAt:period.start-100,updatedAt:period.start-100}],"run-4",{now});
  assert.equal(outside.projects[0].summary.outcome,"no-observed-changes");
  const outsideRead=await readDailyReport(host,organization,{date:period.date,level:"project",subject:target.id});
  assert.deepEqual((outsideRead?.completeness as {updatedAfterWindow:string[]}).updatedAfterWindow,[work.id]);
  projectDoc.generatedBody=projectDoc.generatedBody.replace('"inputDigest":','"owner":{"kind":"organization","id":"forged"},"planningInstallationId":"forged","reference":{"documentId":"forged"},"inputDigest":');
  const trusted=await readDailyReport(host,organization,{date:period.date,level:"project",subject:target.id});
  assert.deepEqual(trusted?.owner,organization.owner);
  assert.equal(trusted?.planningInstallationId,organization.installationId);
  assert.equal((trusted?.reference as {documentId:string}).documentId,projectDoc.id);
  projectDoc.generatedBody=projectDoc.generatedBody.replaceAll(`"start": ${period.start}`,`"start": ${period.start+1}`);
  await assert.rejects(readDailyReport(host,organization,{date:period.date,level:"project",subject:target.id}),error=>error instanceof Response && error.status===409);

 }finally{client.close();}
});

test("personal overview reads pinned organization outcomes, never writes org Wiki, and records missing dependencies as incomplete",async()=>{
 const {client,db}=await setup();try{
  const orgHost=reportHost("org-wiki"),personalHost=reportHost("personal-wiki",async()=>({data:{dailyReports:[{ownerKind:"organization",ownerId:"org",planningInstallationId:organization.installationId,organizationSlug:"example",report:await readDailyReport(orgHost.host,organization,{date:previousReportPeriod(now).date})}]}}),now);
  await runReportChain(db,orgHost.host,organization,[],"org-run",{now});
  const local=await runReportChain(db,personalHost.host,personal,[],"personal-run",{now,includeOverview:false});
  const complete=await savePersonalOverview(personalHost.host,personal,local,"personal-run",now);
  assert.equal(complete.status,"complete");
  const task=await runDigestTask(db,personalHost.host,personal,{runId:"99999999-9999-4999-8999-999999999999",task:"project-digest",inputs:{timezone:"America/Chicago"}});
  assert.equal((task.reports as {status:string}).status,"complete");
  assert.equal(personalHost.calls.at(-1)?.operation,"workflow.collect");
  const note=await readDailyReport(personalHost.host,personal,{date:local.period.date});
  assert.match(JSON.stringify(note),/org-wiki/);
  assert.equal(personalHost.calls.filter(call=>call.operation==="actions.call").every(call=>call.input.installationId==="personal-wiki"),true);
  const absent=reportHost("personal-wiki",async()=>({data:{dailyReports:[{ownerKind:"organization",ownerId:"missing-org",planningInstallationId:"missing-planning",organizationSlug:"missing",report:null}]}}));
  const incomplete=await savePersonalOverview(absent.host,personal,local,"personal-run",now);
  assert.equal(incomplete.status,"incomplete");
  assert.match(JSON.stringify(await readDailyReport(absent.host,personal,{date:local.period.date})),/matching organization report is missing/);
  assert.match(JSON.stringify(await readDailyReport(absent.host,personal,{date:local.period.date})),/"status":"incomplete"/);
 }finally{client.close();}
});


test("an explicit daily recovery date keeps the same Wiki identity after midnight and new task dispatch",async()=>{
 const {client,db}=await setup();try{
  const project=await planning.createProject(db,organization,fields);
  const fixture=reportHost();let anchor=Date.parse("2026-11-02T14:00:00Z");
  const call=fixture.host.call.bind(fixture.host);
  fixture.host.call=(async(operation:string,input:any)=>operation==="workflow.read"?{run:{createdAt:anchor}}:call(operation as never,input as never)) as typeof fixture.host.call;
  await runDigestTask(db,fixture.host,organization,{runId:"77777777-7777-4777-8777-777777777777",task:"project-digest",inputs:{projectId:project.id,timezone:"America/Chicago"}});
  const rolling=await db.select().from(digests);
  await db.update(projects).set({goals:"A current change outside historical recovery",revision:2,updatedAt:Date.now()}).where(eq(projects.id,project.id));
  fixture.calls.length=0;
  const first=await runDigestTask(db,fixture.host,organization,{runId:"55555555-5555-4555-8555-555555555555",task:"project-digest",inputs:{date:"2026-11-01",timezone:"America/Chicago"}});
  anchor=Date.parse("2026-11-03T14:00:00Z");
  const recovered=await runDigestTask(db,fixture.host,organization,{runId:"66666666-6666-4666-8666-666666666666",task:"project-digest",inputs:{date:"2026-11-01",timezone:"America/Chicago"}});
  const before=first.reports as any,after=recovered.reports as any;
  assert.equal(before.period.date,"2026-11-01");assert.deepEqual(after.period,before.period);
  assert.equal(after.projects[0].report.documentId,before.projects[0].report.documentId);
  assert.equal(after.projects[0].report.revision,before.projects[0].report.revision);
  assert.equal(after.overview.documentId,before.overview.documentId);
  assert.deepEqual(await db.select().from(digests),rolling,"historical recovery leaves rolling digest snapshots and cursor untouched");
  assert.equal(fixture.calls.some(call=>call.operation==="inference.generate"),false,"historical recovery runs no current rolling-digest inference");
 }finally{client.close();}
});

test("a daily recovery request rejects current/future local days before dispatch or source writes",async()=>{
 const {client,db}=await setup();try{
  const fixture=reportHost("wiki",undefined,Date.parse("2026-11-02T14:00:00Z"));
  await assert.rejects(runDigestTask(db,fixture.host,organization,{runId:"55555555-5555-4555-8555-555555555555",task:"project-digest",inputs:{date:"2026-11-02",timezone:"America/Chicago"}}),error=>error instanceof Response && error.status===400);
  assert.equal(fixture.calls.filter(call=>call.operation==="actions.call").length,0);
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit"}).format(Date.now());
  await assert.rejects(startDailyReports(fixture.host,organization,{date:today}),error=>error instanceof Response && error.status===400);
  assert.equal(fixture.calls.filter(call=>call.operation==="task.start").length,0);
 }finally{client.close();}
});

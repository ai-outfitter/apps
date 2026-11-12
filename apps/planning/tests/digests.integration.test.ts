import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { OrganizationIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { reportHost } from "./fixtures/report-host";
import { projects } from "../src/server/schema";
import { eq } from "drizzle-orm";
import * as planning from "../src/server/planning";
import { changeDigestSchedule, digestTimezone, listDigests, runDigestTask, scheduledDigests, startDigest } from "../src/server/digests";

const editor: OrganizationIdentity = {
  userId: "bob", organizationId: "org", owner: { kind: "organization", id: "org" },
  installationId: "planning-a", role: "owner", canEdit: true,
};
const member: OrganizationIdentity = { ...editor, userId: "alice", role: "member", canEdit: false };

async function setup() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return { client, db };
}

/** A workflow host double that records calls; inference answers or fails as told. */
function host(inference: "answer" | "fail" = "answer") {
  // biome-ignore lint/suspicious/noExplicitAny: a host double answers every operation's own input shape.
  type Input = Record<string, any>;
  const fixture=reportHost();
  const call=fixture.host.call.bind(fixture.host) as (operation:string,input:Input)=>Promise<unknown>;
  fixture.host.call=(async(operation:string,input:Input)=>{
    if(operation === "inference.generate"){
      fixture.calls.push({operation,input});
      if(inference === "fail")throw new Response("Inference unavailable",{status:502});
      return {output:{headline:"Launch plan shipped",summary:"The team shipped the launch plan."}};
    }
    if(operation === "schedule.save"){
      fixture.calls.push({operation,input});
      return {...input,id:"s1",nextRunAt:1,lastRunAt:null,lastOutcome:null};
    }
    return call(operation,input);
  }) as typeof fixture.host.call;
  return fixture;
}
const issue = (projectId: string, title: string, status: "todo" | "in-progress" | "done" = "todo") =>
  ({ projectId, title, category: "stone" as const, status, description: "", assigneeId: null, dueDate: null, parentId: null });
const project = { name: "Launch", githubRepository: "", goals: "", userStories: "", pressRelease: "", demoInstructions: "", demoResults: "" };

test("the morning run writes a digest for each changed project and skips unchanged ones", async () => {
  const { client, db } = await setup();
  try {
    const launch = await planning.createProject(db, editor, project);
    const quiet = await planning.createProject(db, editor, { ...project, name: "Quiet" });
    const plan = await planning.createIssue(db, editor, issue(launch.id, "Write the launch plan"), []);
    await planning.createIssue(db, editor, issue(quiet.id, "Nothing happens here"), []);

    const first = host();
    assert.equal((await scheduledDigests(db, first.host, editor, "run-1")).written, 2);
    assert.deepEqual(first.calls[0], { operation: "workflow.start", input: { workflow: "project-digest", id: "run-1", inputs: {} } });
    assert.ok(first.calls.filter((call) => call.operation === "inference.generate").every((call) => call.input.step === "summarize" && call.input.runId === "run-1"));
    assert.deepEqual(first.calls.at(-1)?.input.value.written, 2);
    assert.equal(first.calls.at(-1)?.input.slot, "summarize.outputs.digests");

    // Only the launch project changes before the next morning.
    await planning.updateIssue(db, editor, plan.id, { ...issue(launch.id, "Write the launch plan", "done"), revision: plan.revision }, []);
    const second = host();
    const morning = await scheduledDigests(db, second.host, editor, "run-2");
    assert.deepEqual([morning.written, morning.unchanged], [1, 1]);
    const [latest] = await listDigests(db, editor, { projectId: launch.id });
    assert.equal(latest.trigger, "schedule");
    assert.deepEqual(latest.changes.shipped.map((item) => item.title), ["Write the launch plan"]);
    assert.equal(latest.summary, "Launch plan shipped\n\nThe team shipped the launch plan.");
    assert.equal((await listDigests(db, editor, { projectId: quiet.id })).length, 1, "an unchanged project gets no new digest");
    assert.deepEqual(await listDigests(db, { ...editor, installationId: "planning-b" }, { projectId: launch.id }), [], "digests stay in their installation");
  } finally {
    client.close();
  }
});

test("the scheduled local-day report chain is saved before rolling digest inference", async () => {
  const { client, db } = await setup();
  try {
    const target = await planning.createProject(db, editor, project);
    await planning.createIssue(db, editor, issue(target.id, "Check release evidence"), []);
    const fixture = host("fail");
    const scheduledFor = Date.parse("2026-11-13T09:00:00Z"); // 03:00 America/Chicago
    const result = await scheduledDigests(db, fixture.host, editor, "scheduled-run", { now: scheduledFor, timezone: "America/Chicago" });
    assert.deepEqual(result.reports.period, {
      date: "2026-11-12", timezone: "America/Chicago",
      start: Date.parse("2026-11-12T06:00:00Z"), end: Date.parse("2026-11-13T06:00:00Z"),
    });
    assert.equal(result.reports.projects.length, 1);
    assert.ok(result.reports.projects[0].report);
    assert.ok(result.reports.overview);
    const firstReportWrite = fixture.calls.findIndex(call => call.operation === "actions.call" && call.input.action === "graph.mutate");
    const firstInference = fixture.calls.findIndex(call => call.operation === "inference.generate");
    assert.ok(firstReportWrite >= 0 && firstInference > firstReportWrite, "saved reports precede independent inference");
  } finally { client.close(); }
});

test("Generate digest now starts the registered task; the platform's dispatch saves the digest", async () => {
  const { client, db } = await setup();
  try {
    const launch = await planning.createProject(db, member, project);
    await planning.createIssue(db, member, issue(launch.id, "Write the launch plan", "in-progress"), []);
    const starting = host();
    await assert.rejects(startDigest(db, starting.host, member, { projectId: launch.id }), (error) => error instanceof Response && error.status === 403, "task starts need an editor");
    await startDigest(db, starting.host, editor, { projectId: launch.id });
    const start = starting.calls.find((call) => call.operation === "task.start");
    assert.equal(start?.input.task, "project-digest");
    assert.deepEqual(start?.input.inputs, { projectId: launch.id });
    assert.equal(starting.calls.filter((call) => call.operation === "workflow.start").length, 0, "the platform owns the run");

    // The platform dispatches the task as the editor; inference is unavailable, and the digest is still saved.
    const { calls, host: failing } = host("fail");
    const result = await runDigestTask(db, failing, editor, { runId: "99999999-9999-4999-8999-999999999999", task: "project-digest", inputs: { projectId: launch.id } }) as { digestIds: string[] };
    const [digest] = await listDigests(db, editor, { projectId: launch.id });
    assert.deepEqual(result.digestIds, [digest.id]);
    assert.equal(digest.summary, null);
    assert.equal(digest.summaryError, "Inference unavailable");
    assert.deepEqual(digest.changes.started.map((entry) => entry.title), ["Write the launch plan"]);
    assert.deepEqual(calls.at(-1), { operation: "workflow.collect", input: { runId: "99999999-9999-4999-8999-999999999999", slot: "summarize.outputs.digests", value: result } });
    await assert.rejects(startDigest(db, starting.host, editor, { projectId: crypto.randomUUID() }), (error) => error instanceof Response && error.status === 404);
  } finally {
    client.close();
  }
});

test("only editors turn the morning digest on", async () => {
  const { calls, host: double } = host();
  await assert.rejects(changeDigestSchedule(double, member, { enabled: true }), (error) => error instanceof Response && error.status === 403);
  assert.deepEqual(await changeDigestSchedule(double, editor, { enabled: true }), {cron:"0 3 * * *",timezone:"America/Chicago", enabled: true, nextRunAt: 1, lastRunAt: null, lastOutcome: null });
  assert.deepEqual(calls.at(-1)?.input, { workflow: "project-digest",cron:"0 3 * * *", timezone: digestTimezone, enabled: true, inputs: {} });
});


test("recurrence selects explicit active state and writes a complete no-change daily note", async () => {
 const {client,db}=await setup();
 try {
  const active=await planning.createProject(db,editor,{...project,name:"Active"});
  for(const state of ["draft","backlog","completed","archived"] as const) {
   const other=await planning.createProject(db,editor,{...project,name:state});
   await db.update(projects).set({state}).where(eq(projects.id,other.id));
  }
  await planning.createIssue(db,editor,issue(active.id,"Initial work"),[]);
  const first=host();
  assert.equal((await scheduledDigests(db,first.host,editor,"states")).written,1);
  const second=host();
  assert.equal((await scheduledDigests(db,second.host,editor,"quiet")).unchanged,1);
  const writes=second.calls.filter(call=>call.operation==="actions.call" && call.input.action==="graph.mutate");
  const generated=writes.filter(call=>call.input.input.query.includes("SaveGeneratedDocument"));
  assert.equal(generated.length,2,"project note then dependent organization overview");
  const draft=generated[0].input.input.variables.input;
  assert.match(draft.generatedBody,/no-observed-changes/);
  assert.match(draft.generatedBody,/"reads": "complete"/);
  assert.match(draft.generatedBody,/Conversation transcripts and deployment verification were not read/);
  assert.equal((await listDigests(db,editor,{projectId:active.id})).length,1);
 } finally {client.close();}
});

test("retrying a saved run recovers Wiki export without another digest or inference",async()=>{
 const {client,db}=await setup();
 try {
  const target=await planning.createProject(db,editor,project);
  await planning.createIssue(db,editor,issue(target.id,"Initial work"),[]);
  const original=host();
  const failing={call:async(operation:string,input:never)=>{
   if(operation==="actions.list")throw new Error("Wiki unavailable");
   return original.host.call(operation as never,input);
  }} as WorkflowHost<"schedule">;
  await assert.rejects(scheduledDigests(db,failing,editor,"retry"),error=>error instanceof Response && error.status===502);
  assert.equal((await listDigests(db,editor,{projectId:target.id})).length,1);
  const recovery=host();
  await scheduledDigests(db,recovery.host,editor,"retry");
  assert.equal((await listDigests(db,editor,{projectId:target.id})).length,1);
  assert.equal(recovery.calls.filter(call=>call.operation==="inference.generate").length,0);
 } finally {client.close();}
});

test("failed Planning reads never become no-change notes",async()=>{
 const {client,db}=await setup();
 try {
  await planning.createProject(db,editor,project);
  await client.execute("DROP TABLE planning_issues");
  const attempt=host();
  await assert.rejects(scheduledDigests(db,attempt.host,editor,"broken-source"));
  const generated=[...attempt.documents.values()].map(doc=>doc.generatedBody).join("\n");
  assert.match(generated,/Planning source reads failed/);
  assert.match(generated,/project-reports-incomplete/);
  assert.equal(attempt.calls.at(-1)?.input.complete,false,"a failed source cannot complete the workflow output");
 } finally {client.close();}
});

test("repeated runs preserve identical generated reports without creating more revisions",async()=>{
 const {client,db}=await setup();
 try {
  await planning.createProject(db,editor,project);
  const attempt=host();
  await scheduledDigests(db,attempt.host,editor,"quiet-1");
  await scheduledDigests(db,attempt.host,editor,"quiet-2");
  assert.equal(attempt.calls.filter(call=>call.operation==="actions.call" && call.input.action==="graph.mutate").length,2);
 } finally {client.close();}
});

test("an incomplete Wiki lookup fails without creating a replacement page",async()=>{
 const {client,db}=await setup();
 try {
  await planning.createProject(db,editor,project);
  const backing=host();
  const incomplete={call:async(operation:string,input:Record<string,unknown>)=>{
   if(operation==="actions.call" && input.action==="graph.graphql")return {data:{page:null},extensions:{truncated:true}};
   return backing.host.call(operation as never,input as never);
  }} as WorkflowHost<"schedule">;
  await assert.rejects(scheduledDigests(db,incomplete,editor,"incomplete"),error=>error instanceof Response && error.status===502);
  assert.equal(backing.calls.filter(call=>call.operation==="actions.call" && call.input.action==="graph.mutate").length,0);
 } finally {client.close();}
});

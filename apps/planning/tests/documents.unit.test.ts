import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient, type InValue } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { graphqlAction, mutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { documents, runDocument } from "../src/server/documents";
import { graphqlSchema } from "../src/server/graphql";
import type { PlanningContext } from "../src/server/intake";
import { createProject } from "../src/server/planning";

// Each document runs through graph.mutate (or graph.graphql) as the platform's graph_mutate and
// graph_query call it: the field's own policy admits or refuses the caller, invalid input is a
// BAD_USER_INPUT error, and a field's refusal keeps its status. A page route runs the same
// document in process through runDocument and answers the Response the field refused with.
type Errors = { message: string; extensions?: Record<string, unknown>; path?: (string | number)[] }[];
type Result = { data: Record<string, Record<string, unknown> | null> | null; errors?: Errors };
const status = (code: number) => (error: unknown) => error instanceof Response && error.status === code;
// As the actions route mounts it: every member reaches graph.mutate, each field checks its own policy.
const mutate = mutateAction(graphqlSchema, { canInvoke: () => true });
const query = graphqlAction(graphqlSchema);
const run = (context: PlanningContext, name: keyof typeof documents, variables: Record<string, unknown>) =>
  (documents[name].document.definitions[0] as { operation: string }).operation === "mutation"
    ? (mutate.invoke(context, { query: documentText(documents[name].document), operationName: name, variables }) as Promise<Result>)
    : (query.invoke(context, { query: documentText(documents[name].document), operationName: name, variables }) as Promise<Result>);
const first = (result: Result) => result.errors?.[0]?.message ?? "no error";
const refused = (result: Result, code: number, message?: RegExp) => {
  assert.deepEqual(result.errors?.[0]?.extensions, { code: "REFUSED", status: code }, first(result));
  if (message) assert.match(result.errors?.[0]?.message ?? "", message);
};
/** The named field of a result that has no errors. */
const field = <T>(result: Result, name: string): T => {
  assert.equal(result.errors, undefined, first(result));
  return result.data?.[name] as T;
};
const invalid = (result: Result) => assert.equal(result.errors?.[0]?.extensions?.code, "BAD_USER_INPUT", first(result));

const gate = { installationId: "governance", controlId: "10000000-0000-4000-8000-000000000001" };
const research = { kind: "research", dependsOn: [], rationale: "Compare alternatives", gate };
const result = { summary: "Alternatives examined", sources: [{ url: "https://example.test/research", observedAt: "2026-10-29T00:00:00Z", excerpt: "Observed" }], gaps: [] };

/** Planning's installation database and agent store on one in-memory SQLite, with a host that
 * answers what the intake lifecycle asks: a Wiki, one gate policy whose duty `holder` holds,
 * gate requests and verifications, and Wiki nodes publishResult creates. Routing is unavailable. */
async function fixture() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  const nodes = new Map<string, Record<string, unknown>>();
  const state = { holder: "holder", approved: false };
  const refuse = (text: string, status: number) => { throw new Response(text, { status }); };
  const answers: Record<string, (input: Record<string, unknown>) => unknown> = {
    "entities.types": () => ["graph-type", "graph-node", "graph-edge"].map((type) => ({ type, installationId: "wiki", writable: true })),
    "entities.resolve": () => ({ installationId: "wiki" }),
    "identity.resolve": () => ({ holderId: state.holder }),
    "entities.get": (input) => nodes.get(String(input.id)) ?? refuse("Not found", 404),
    "entities.create": (input) => {
      const attributes = input.attributes as Record<string, unknown>;
      const node = { ref: { installationId: "wiki", type: "graph-node", id: attributes.id }, revision: 1, title: attributes.title, attributes, references: input.references };
      nodes.set(String(attributes.id), node);
      return node;
    },
    "workflow.start": () => refuse("Routing unavailable", 503),
    "governance.gate-policy": () => ({ workKinds: ["research", "architecture", "prioritization", "backlog", "implementation"], evidenceRequirements: { researchCitations: true, resolvedGaps: true }, duties: [{ duty: "perform", assignment: { holderId: "holder" } }] }),
    "governance.request-gate": () => ({ id: "gate-1" }),
    "governance.verify-gate": () => (state.approved ? { verified: true } : refuse("Decision required", 409)),
  };
  const host = {
    call: async (name: string, raw: unknown) => {
      const input = raw as Record<string, unknown>;
      const answer = answers[name === "actions.call" ? String(input.action) : name];
      if (!answer) throw new Error(`Unexpected ${name}: ${JSON.stringify(input)}`);
      return answer(input);
    },
  };
  const store = {
    query: async (s: { sql: string; params?: unknown[] }) => (await client.execute({ sql: s.sql, args: (s.params ?? []) as InValue[] })).rows as Record<string, unknown>[],
    batch: async (ss: { sql: string; params?: unknown[] }[]) => client.batch(ss.map((s) => ({ sql: s.sql, args: (s.params ?? []) as InValue[] })), "write"),
  };
  const caller = (userId: string, canEdit: boolean, members: () => string[] = () => ["alice", "bob"]): PlanningContext => {
    const actor = { kind: "member" as const, id: userId };
    return {
      identity: { userId, organizationId: "org", owner: { kind: "organization", id: "org" }, installationId: "planning", role: canEdit ? "owner" : "member", canEdit },
      actor, originActor: actor, members, db: () => db, host: () => host, store: () => store,
    } as unknown as PlanningContext;
  };
  return { db, close: () => client.close(), caller, state, nodes };
}

test("issue documents: any member writes through graph.mutate or the page route; revisions and assignees are checked", async () => {
  const f = await fixture();
  try {
    const member = f.caller("alice", false);
    const project = await createProject(f.db, member.identity, { name: "Launch" });
    const issue = { projectId: project.id, title: "Choose the outcome", category: "stone" as const, description: "", status: "todo", assigneeId: null, dueDate: null, parentId: null };
    const created = await run(member, "CreateIssue", { input: issue });
    assert.equal(created.errors, undefined);
    const stone = field<{ id: string; revision: number; position: number; status: string; createdAt: string }>(created, "createIssue");
    assert.deepEqual([stone.revision, stone.position, stone.status], [1, 0, "todo"]);
    assert.match(stone.createdAt, /^\d{4}-/);
    // The zod schema still validates after the GraphQL type admits the shape; an unknown field never reaches it.
    invalid(await run(member, "CreateIssue", { input: { ...issue, title: "" } }));
    assert.match((await run(member, "CreateIssue", { input: { ...issue, extra: true } })).errors?.[0]?.message ?? "", /extra/);
    // Assignment needs the organization directory and a current member.
    refused(await run(member, "CreateIssue", { input: { ...issue, assigneeId: "carol" } }), 400, /current organization member/);
    refused(await run(f.caller("alice", false, () => { throw new Response("Organization directory unavailable", { status: 503 }); }), "CreateIssue", { input: { ...issue, assigneeId: "bob" } }), 503);
    const assigned = field<{ id: string; revision: number }>(await run(member, "CreateIssue", { input: { ...issue, title: "Assigned", assigneeId: "bob" } }), "createIssue");

    // Updates name the revision they read; without a directory an update keeps only the stored assignee.
    const change = { ...issue, id: stone.id, revision: stone.revision, status: "done" };
    const done = field<{ revision: number; status: string }>(await run(member, "UpdateIssue", { input: change }), "updateIssue");
    assert.deepEqual([done.revision, done.status], [2, "done"]);
    refused(await run(member, "UpdateIssue", { input: change }), 409, /changed/);
    const offline = f.caller("alice", false, () => { throw new Response("Organization directory unavailable", { status: 503 }); });
    const kept = await run(offline, "UpdateIssue", { input: { ...issue, id: assigned.id, revision: assigned.revision, title: "Assigned still", assigneeId: "bob" } });
    assert.equal(field<{ assigneeId: string }>(kept, "updateIssue").assigneeId, "bob");
    refused(await run(offline, "UpdateIssue", { input: { ...issue, id: assigned.id, revision: assigned.revision + 1, assigneeId: "alice" } }), 400, /current organization member/);

    // Reordering names every issue of the category at its revision; deleting too.
    const reordered = await run(member, "ReorderIssues", { input: { projectId: project.id, category: "stone", items: [{ id: assigned.id, revision: 2 }, { id: stone.id, revision: 2 }] } });
    assert.deepEqual(field(reordered, "reorderIssues"), { reordered: true });
    refused(await run(member, "ReorderIssues", { input: { projectId: project.id, category: "stone", items: [{ id: stone.id, revision: 3 }] } }), 409);
    refused(await run(member, "DeleteProject", { input: { id: project.id, revision: 1 } }), 409, /check the project/);
    assert.deepEqual(field(await run(member, "DeleteIssue", { input: { id: stone.id, revision: 3 } }), "deleteIssue"), { deleted: true });
    assert.deepEqual(field(await run(member, "DeleteIssue", { input: { id: assigned.id, revision: 3 } }), "deleteIssue"), { deleted: true });
    assert.deepEqual(field(await run(member, "DeleteProject", { input: { id: project.id, revision: 1 } }), "deleteProject"), { deleted: true });

    // The page route runs the same document in process: a refusal is the Response it would have thrown,
    // invalid input (zod, or a variable the document's type rejects) an opaque 400.
    const again = await createProject(f.db, member.identity, { name: "Again" });
    const page = await runDocument(documents.CreateIssue.document, { input: { ...issue, projectId: again.id, category: "sand" } }, member);
    assert.deepEqual([page.createIssue.category, page.createIssue.position], ["sand", 0]);
    await assert.rejects(runDocument(documents.DeleteIssue.document, { input: { id: page.createIssue.id, revision: 9 } }, member), status(409));
    await assert.rejects(runDocument(documents.CreateIssue.document, { input: { ...issue, projectId: again.id, title: "" } }, member), status(400));
    const coerced = await runDocument(documents.CreateIssue.document, { input: { ...issue, projectId: again.id, extra: true } as never }, member).then(() => null, (error: unknown) => error);
    assert.ok(status(400)(coerced));
    assert.equal(await (coerced as Response).text(), "Invalid input");
    // An unexpected failure inside a field is not the caller's: it is rethrown for the route's 500, as before.
    const broken = { ...member, db: () => { throw new Error("database unavailable"); } } as PlanningContext;
    await assert.rejects(runDocument(documents.DeleteIssue.document, { input: { id: page.createIssue.id, revision: 1 } }, broken),
      (error: unknown) => error instanceof Error && !(error instanceof Response) && /deleteIssue: database unavailable/.test(error.message));
  } finally { f.close(); }
});

test("project documents: any member creates and updates a project at the revision read, with documents past 32 KiB", async () => {
  const f = await fixture();
  try {
    const member = f.caller("alice", false);
    // Five documents of up to 16,000 characters each: well past graph.graphql's 32 KiB of variables.
    const long = "x".repeat(16000);
    const project = { name: "Launch", githubRepository: "https://www.github.com/acme/app/", goals: long, userStories: long, pressRelease: long };
    type Project = { id: string; revision: number; githubRepository: string | null; goals: string; userStories: string; demoResults: string; openIssues: number };
    const created = field<Project>(await run(member, "CreateProject", { input: project }), "createProject");
    assert.deepEqual([created.revision, created.githubRepository, created.goals.length, created.openIssues], [1, "https://github.com/acme/app", 16000, 0]);
    invalid(await run(member, "CreateProject", { input: { ...project, name: " " } }));
    invalid(await run(member, "CreateProject", { input: { ...project, goals: `${long}x` } }));

    // An update replaces every document: one left out is cleared.
    const change = { id: created.id, revision: created.revision, name: "Launch", goals: long, demoResults: "Shown" };
    const updated = field<Project>(await run(member, "UpdateProject", { input: change }), "updateProject");
    assert.deepEqual([updated.revision, updated.userStories, updated.demoResults], [2, "", "Shown"]);
    refused(await run(member, "UpdateProject", { input: change }), 409, /changed/);
    invalid(await run(member, "UpdateProject", { input: { ...change, revision: 2, githubRepository: "https://example.test/acme" } }));

    // The project page runs the same documents in process.
    const page = await runDocument(documents.UpdateProject.document, { input: { ...change, revision: 2, pressRelease: long } }, member);
    assert.equal(page.updateProject.revision, 3);
    await assert.rejects(runDocument(documents.UpdateProject.document, { input: change }, member), status(409));
    await assert.rejects(runDocument(documents.CreateProject.document, { input: { name: "" } }, member), status(400));
  } finally { f.close(); }
});

test("intake delivery documents: review is asked again only for a recorded result; previews and submissions need implementation work", async () => {
  const f = await fixture();
  try {
    const editor = f.caller("editor", true);
    const member = f.caller("agent", false);
    const intake = { requestId: "20000000-0000-4000-8000-000000000011", kind: "use-case", title: "Faster checkout", description: "Compare alternatives" };
    const saved = field<{ id: string; revision: number }>(await run(editor, "CreateIntake", { input: intake }), "createIntake");
    const routed = field<{ routes: { id: string }[] }>(
      await run(editor, "RouteIntake", { input: { intakeId: saved.id, revision: saved.revision, proposal: { routes: [research] } } }), "routeIntake");
    const route = { intakeId: saved.id, childId: routed.routes[0].id };

    // Without token and result, RecordResult asks for review again: a duty holder may, once a result exists.
    refused(await run(member, "RecordResult", { input: route }), 409, /No result is recorded/);
    invalid(await run(member, "RecordResult", { input: { ...route, childId: "not-an-id" } }));
    // Preview and submit apply to implementation work; submitting is an editor's.
    const preview = { projectId: "30000000-0000-4000-8000-000000000001" };
    refused(await run(member, "IntakeWorkPreview", { input: { ...route, preview } }), 409, /Select implementation work/);
    const work = { requestId: "20000000-0000-4000-8000-000000000013", preview, expectedDigest: "a".repeat(64), foundryInstallationId: "foundry", foundryProjectId: "p", governanceInstallationId: "governance", controlId: gate.controlId };
    refused(await run(member, "SubmitIntakeWork", { input: { ...route, work } }), 403);
    refused(await run(editor, "SubmitIntakeWork", { input: { ...route, work } }), 409, /Select implementation work/);
    invalid(await run(editor, "SubmitIntakeWork", { input: { ...route, work: { ...work, expectedDigest: "short" } } }));
  } finally { f.close(); }
});

test("intake documents: editors capture and route, the assigned holder claims, records and publishes, and Intakes shows the work", async () => {
  const f = await fixture();
  try {
    const editor = f.caller("editor", true);
    const holder = f.caller("agent", false);
    const intake = { requestId: "20000000-0000-4000-8000-000000000001", kind: "customer-problem", title: "Simpler booking", description: "Compare alternatives", sourceUrls: ["https://example.test/competitor"] };
    refused(await run(holder, "CreateIntake", { input: intake }), 403);
    invalid(await run(editor, "CreateIntake", { input: { ...intake, kind: "wish" } }));
    // Routing is unavailable in this fixture: the intake is saved and says so.
    const created = await run(editor, "CreateIntake", { input: intake });
    assert.equal(created.errors, undefined);
    const saved = field<{ id: string; revision: number; routes: unknown[]; routingError: string; routing: { state: string } }>(created, "createIntake");
    assert.deepEqual([saved.id, saved.routes, saved.routingError, saved.routing.state], [intake.requestId, [], "Routing unavailable", "failed"]);
    // Replaying the requestId returns the saved intake; a different scope under it is refused.
    assert.equal(field<{ id: string }>(await run(editor, "CreateIntake", { input: intake }), "createIntake").id, saved.id);
    refused(await run(editor, "CreateIntake", { input: { ...intake, title: "Other" } }), 409);

    // The editor sets the routes at the revision read; the holder may not.
    const plan = { intakeId: saved.id, revision: saved.revision, proposal: { routes: [research, { kind: "architecture", dependsOn: ["research"], rationale: "Choose approach", gate }] } };
    refused(await run(holder, "RouteIntake", { input: plan }), 403);
    refused(await run(editor, "RouteIntake", { input: { ...plan, revision: 9 } }), 409, /Intake changed/);
    const routed = field<{ revision: number; routes: { id: string; kind: string; blocker: string | null }[] }>(await run(editor, "RouteIntake", { input: plan }), "routeIntake");
    assert.deepEqual(routed.routes.map((route) => [route.kind, route.blocker]), [["research", null], ["architecture", "Waiting for research"]]);
    const [researchRoute, architectureRoute] = routed.routes;

    // Claiming needs the control's duty; the claim carries the work's deterministic context.
    const claim = { intakeId: saved.id, childId: researchRoute.id, requestId: "20000000-0000-4000-8000-000000000002" };
    f.state.holder = "other";
    refused(await run(holder, "ClaimWork", { input: claim }), 403, /Not assigned/);
    f.state.holder = "holder";
    refused(await run(holder, "ClaimWork", { input: { ...claim, childId: architectureRoute.id } }), 409, /Waiting for research/);
    const claimed = field<{ token: string; context: { markdown: string; digest: string } }>(await run(holder, "ClaimWork", { input: claim }), "claimWork");
    assert.equal(claimed.token, claim.requestId);
    assert.match(claimed.context.markdown, /Simpler booking/);
    assert.match(claimed.context.digest, /^[a-f0-9]{64}$/);

    // Recording under the claim requests the gate; the editor holds no claim.
    const record = { intakeId: saved.id, childId: researchRoute.id, token: claimed.token, result };
    refused(await run(editor, "RecordResult", { input: record }), 403, /claim required/);
    invalid(await run(holder, "RecordResult", { input: { ...record, result: { ...result, sources: [{ ...result.sources[0], observedAt: "yesterday" }] } } }));
    const recorded = field<{ routes: { revision: number; result: { summary: string } | null; gateReceipt: unknown; blocker: string | null }[] }>(await run(holder, "RecordResult", { input: record }), "recordResult");
    assert.deepEqual([recorded.routes[0].revision, recorded.routes[0].result?.summary, recorded.routes[0].gateReceipt], [2, result.summary, { id: "gate-1" }]);
    // Once approved, dependent work is ready.
    f.state.approved = true;
    const listed = await run(holder, "Intakes", {});
    const [node] = field<{ nodes: { id: string; routes: { kind: string; blocker: string | null; claim: { principal: string } | null }[] }[] }>(listed, "intakes").nodes;
    assert.deepEqual(node.routes.map((route) => [route.kind, route.blocker, route.claim?.principal ?? null]), [["research", null, "agent"], ["architecture", null, null]]);
    assert.deepEqual(field<{ pageInfo: { hasNextPage: boolean } }>(listed, "intakes").pageInfo.hasNextPage, false);
    // The field itself takes ids, as every collection does, for a read of one intake over the composed graph.
    const byId = (ids: string[]) => query.invoke(holder, { query: "query ($ids: [ID!]) { intakes(ids: $ids) { nodes { id } aggregate { count } } }", variables: { ids } }) as Promise<Result>;
    assert.deepEqual(field(await byId([saved.id]), "intakes"), { nodes: [{ id: saved.id }], aggregate: { count: 1 } });
    assert.deepEqual(field(await byId(["20000000-0000-4000-8000-000000000009"]), "intakes"), { nodes: [], aggregate: { count: 0 } });

    // Publishing writes the intake node and the finding to the Wiki, once.
    const publish = { intakeId: saved.id, childId: researchRoute.id };
    f.state.holder = "other";
    refused(await run(holder, "PublishResult", { input: publish }), 403, /Not assigned/);
    f.state.holder = "holder";
    const published = field<{ ref: { id: string }; attributes: { body: string } }>(await run(holder, "PublishResult", { input: publish }), "publishResult");
    assert.equal(published.ref.id, researchRoute.id);
    assert.equal(JSON.parse(published.attributes.body).status, "proposed");
    assert.equal(f.nodes.size, 2);
    assert.deepEqual(field<{ ref: unknown }>(await run(editor, "PublishResult", { input: publish }), "publishResult").ref, published.ref);
    refused(await run(editor, "PublishResult", { input: { ...publish, childId: architectureRoute.id } }), 409, /No result/);
  } finally { f.close(); }
});

test("SaveUseCase gates and validates as the use cases page does before touching the Wiki", async () => {
  const f = await fixture();
  try {
    const useCase = { projectId: "30000000-0000-4000-8000-000000000001", title: "Book a stay", document: { actor: "Guest", goal: "Book", trigger: "Search", steps: "Pick", alternatives: "None", successCriteria: "Booked" } };
    refused(await run(f.caller("alice", false), "SaveUseCase", { input: useCase }), 403);
    invalid(await run(f.caller("editor", true), "SaveUseCase", { input: { ...useCase, title: " " } }));
    refused(await run(f.caller("editor", true), "SaveUseCase", { input: { ...useCase, id: "30000000-0000-4000-8000-000000000002" } }), 400, /both ID and revision/);
    // An editor reaches saveUseCase itself: the unknown project is its refusal.
    refused(await run(f.caller("editor", true), "SaveUseCase", { input: useCase }), 404);
  } finally { f.close(); }
});

test("MutateProject masks preserve omitted fields, archive retains content, and keys reconcile retries",async()=>{
 const f=await fixture();
 try {
  const caller=f.caller("alice",false);
  const change=async(items:unknown[])=>field<any>(await run(caller,"MutateProject",{input:{items}}),"mutateProject");
  const key=crypto.randomUUID();
  const create={key,action:"create",input:{name:"Synthetic agent project",goals:"Keep this outcome",demoResults:"Existing evidence"}};
  const created=await change([create]);
  assert.equal(created.items[0].status,"complete",JSON.stringify(created));assert.deepEqual(created.instructions,[]);
  const project=created.items[0].result;
  assert.equal(project.revision,1);
  assert.deepEqual(await change([create]),created,"lost-response replay returns the retained receipt");
  assert.equal((await change([{...create,input:{name:"Changed input"}}])).items[0].error.code,"IDEMPOTENCY_CONFLICT");
  const edit=await change([{key:crypto.randomUUID(),action:"edit",input:{project:{...project,organizationSlug:"synthetic",useCases:[]},mask:{name:"Renamed by agent"}}}]);
  assert.equal(edit.items[0].status,"complete",JSON.stringify(edit));
  const edited=edit.items[0].result;
  assert.equal(edited.name,"Renamed by agent");const [stored]=await f.db.select().from((await import("../src/server/schema")).projects);assert.equal(stored.goals,"Keep this outcome");assert.equal(stored.demoResults,"Existing evidence");assert.equal(edited.revision,2);
  const mixed=await change([
   {key:crypto.randomUUID(),action:"edit",input:{project,mask:{goals:"Stale overwrite"}}},
   {key:crypto.randomUUID(),action:"create",input:{name:"Independent success"}},
   {key:crypto.randomUUID(),action:"edit",input:{project:edited,mask:{}}},
   {key:crypto.randomUUID(),action:"edit",input:{project:edited,mask:{archived:true}}},
  ]);
  assert.deepEqual(mixed.items.map((item:any)=>item.status),["uncertain","complete","failed","failed"]);
  const foreign=f.caller("alice",false);foreign.identity={...foreign.identity,installationId:"foreign"};
  const denied=field<any>(await run(foreign,"MutateProject",{input:{items:[{key:crypto.randomUUID(),action:"edit",input:{project:edited,mask:{name:"Cross-tenant"}}}]}}),"mutateProject");
  assert.equal(denied.items[0].status,"uncertain");
  const archived=await change([{key:crypto.randomUUID(),action:"archive",input:{project:edited}}]);
  assert.equal(archived.items[0].result.archived,true);
  const visible=field<any>(await query.invoke(caller,{query:"{projects {nodes{id name}}}"}) as Result,"projects");
  assert.ok(!visible.nodes.some((row:any)=>row.id===project.id));
  const retained=field<any>(await query.invoke(caller,{query:"{projects(archived:true){nodes{id goals archived}}}"}) as Result,"projects");
  assert.equal(retained.nodes[0].goals,"Keep this outcome");
  const rows=await f.db.select().from((await import("../src/server/schema")).projects);
  assert.equal(rows.find(row=>row.id===project.id)?.updatedBy,"alice");
 }finally{f.close();}
});

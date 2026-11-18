import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mutateAction, serveGraphql } from "@ai-outfitter/app-sdk/app-graphql";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { documents, runDocument } from "../src/server/documents";
import { graphqlSchema, type WorkshopContext } from "../src/server/graphql";
import { AssemblySchema } from "../src/lib/assembly";
import { getWorkshopProject } from "../src/server/projects";

// Each mutation document runs through graph.mutate as the platform's graph_mutate calls it,
// admitting every member as the page does: a starter example becomes a first-revision
// project, a delete takes the revision the caller saw, concept writes refuse what is not
// there, invalid input is a BAD_USER_INPUT error, and a field's own refusal keeps its status. The page's routes run the same
// documents in process (runDocument). The cap and whole-project saves are covered by the
// repository's tests/workshop-projects.test.ts through the routes.
const status = (code: number) => (error: unknown) => error instanceof Response && error.status === code;
const mutate = mutateAction(graphqlSchema, { canInvoke: () => true });
type Result = { data: Record<string, Record<string, unknown> | string | null> | null; errors?: { message: string; extensions?: Record<string, unknown> }[] };
const run = (context: WorkshopContext, name: keyof typeof documents, input: unknown) =>
  mutate.invoke(context, { query: documentText(documents[name].document), operationName: name, variables: { input } }) as Promise<Result>;
/** The row a mutation answered with, as the agent reads it. */
const answer = (result: Result, field: string) => (result.data?.[field] ?? {}) as Record<string, unknown>;

async function workshopDatabase() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return { db, close: () => client.close() };
}
/** A plain member: Workshop lets every member write. */
const member = (db: Awaited<ReturnType<typeof workshopDatabase>>["db"]): WorkshopContext => {
  const actor = { kind: "member" as const, id: "u1" };
  return {
    identity: { userId: "u1", organizationId: "org", owner: { kind: "organization", id: "org" }, installationId: "workshop", role: "member", access: "read", canEdit: false },
    actor, originActor: actor, db: () => db,
    storage: () => { throw new Error("no storage in this test"); },
    host: () => { throw new Error("no workflow host in this test"); },
    origin: () => "https://workshop.example",
  };
};

test("a member starts a project from an example and deletes it at its revision through graph.mutate", async () => {
  const { db, close } = await workshopDatabase();
  try {
    const writer = member(db);
    const created = await run(writer, "CreateWorkshopProject", { example: "cube" });
    assert.equal(created.errors, undefined);
    const project = created.data?.createWorkshopProject as Record<string, unknown>;
    assert.deepEqual([project.name, project.revision, project.createdBy, project.updatedBy], ["Solid cube", 1, "u1", "u1"]);
    assert.match(String(project.createdAt), /^\d{4}-\d{2}-\d{2}T/);
    // The page reads the whole project the example made, at its first revision.
    const whole = await getWorkshopProject(db, String(project.id));
    assert.deepEqual([whole.params.design, whole.revision], ["cube", 1]);

    // The zod enum still validates after the GraphQL type admits the shape.
    assert.match((await run(writer, "CreateWorkshopProject", { example: "rocket" })).errors?.[0]?.message ?? "", /example/);
    assert.match((await run(writer, "CreateWorkshopProject", { project: {} })).errors?.[0]?.message ?? "", /project/);

    assert.deepEqual((await run(writer, "DeleteWorkshopProject", { id: project.id, revision: 2 })).errors?.[0]?.extensions, { code: "REFUSED", status: 409 });
    assert.deepEqual((await run(writer, "DeleteWorkshopProject", { id: crypto.randomUUID(), revision: 1 })).errors?.[0]?.extensions, { code: "REFUSED", status: 404 });
    assert.deepEqual((await run(writer, "DeleteWorkshopProject", { id: "not-a-uuid", revision: 1 })).errors?.[0]?.extensions, { code: "REFUSED", status: 404 });
    // Concepts: a missing concept is refused before storage is touched; publishing needs a concept first.
    assert.deepEqual((await run(writer, "RemoveWorkshopConcept", { projectId: project.id, conceptId: "c1", revision: 1 })).errors?.[0]?.extensions, { code: "REFUSED", status: 404 });
    assert.deepEqual((await run(writer, "PublishWorkshopConcepts", { projectId: project.id, productRevisionId: crypto.randomUUID(), revision: 1 })).errors?.[0]?.extensions, { code: "REFUSED", status: 409 });
    assert.equal((await run(writer, "DeleteWorkshopProject", { id: project.id, revision: 1 })).data?.deleteWorkshopProject, project.id);
    await assert.rejects(getWorkshopProject(db, String(project.id)), status(404));

    // The routes run the same documents in process: a refusal is the Response the route answers
    // with, invalid input an opaque 400, and an unexpected failure is rethrown for its 500.
    const page = await runDocument(documents.CreateWorkshopProject.document, { input: { example: "holder" } }, writer);
    assert.equal(page.createWorkshopProject.name, "Cable keeper");
    await assert.rejects(runDocument(documents.DeleteWorkshopProject.document, { input: { id: page.createWorkshopProject.id, revision: 3 } }, writer), status(409));
    await assert.rejects(runDocument(documents.CreateWorkshopProject.document, { input: { example: "rocket" } as never }, writer), status(400));
    const broken = { ...writer, db: () => { throw new Error("database unavailable"); } };
    await assert.rejects(runDocument(documents.CreateWorkshopProject.document, { input: { example: "cube" } }, broken),
      (error: unknown) => error instanceof Error && !(error instanceof Response) && /createWorkshopProject: database unavailable/.test(error.message));
  } finally { close(); }
});

test("an agent starts a linked project and builds it by document: describe, link and save the assembly at each revision", async () => {
  const { db, close } = await workshopDatabase();
  try {
    const writer = member(db);
    const revisionId = crypto.randomUUID();
    // Planning starts the project named for the product revision it builds, in one write.
    const created = await run(writer, "CreateWorkshopProject", {
      example: "node", name: "SNY-1 sensor node", productRevision: { id: revisionId, wikiInstallationId: "wiki-1", title: "SNY-1 rev A" },
    });
    assert.equal(created.errors, undefined);
    const project = created.data?.createWorkshopProject as Record<string, unknown>;
    assert.deepEqual([project.name, project.revision, project.productRevisionId, project.productRevisionTitle], ["SNY-1 sensor node", 1, revisionId, "SNY-1 rev A"]);
    const id = String(project.id);
    assert.deepEqual((await getWorkshopProject(db, id)).productRevision, { id: revisionId, wikiInstallationId: "wiki-1", title: "SNY-1 rev A", url: "" });

    // Words and stage: fields left out keep their value; a stale revision is refused.
    const described = await run(writer, "DescribeWorkshopProject", { id, revision: 1, phase: "prototyping", brief: "A consumer sensor node." });
    assert.equal(answer(described, "describeWorkshopProject").revision, 2);
    const afterDescribe = await getWorkshopProject(db, id);
    assert.deepEqual([afterDescribe.name, afterDescribe.phase, afterDescribe.brief, afterDescribe.productRevision?.id], ["SNY-1 sensor node", "prototyping", "A consumer sensor node.", revisionId]);
    assert.deepEqual((await run(writer, "DescribeWorkshopProject", { id, revision: 1, name: "Late" })).errors?.[0]?.extensions, { code: "REFUSED", status: 409 });
    assert.match((await run(writer, "DescribeWorkshopProject", { id, revision: 2, phase: "shipping" })).errors?.[0]?.message ?? "", /phase/);

    // The product structure, in the shape the page's BOM and 3D view read.
    const top = crypto.randomUUID();
    const board = crypto.randomUUID();
    const assembly = {
      rootId: top,
      items: [
        { id: top, number: "SNY-1-A", revision: "A", name: "Sensor node", kind: "assembly", uses: [{ id: crypto.randomUUID(), itemId: board, quantity: 1, refdes: "PCB1", position: [0, 0, 2], rotation: 90 }] },
        { id: board, number: "SNY-1-PCB", revision: "A", name: "Main board", kind: "pcb", manufacturer: "JLCPCB", unitCost: 4.5, trackBy: "mac" },
      ],
    };
    const saved = await run(writer, "SaveWorkshopAssembly", { id, revision: 2, assembly });
    assert.equal(saved.errors, undefined);
    assert.equal(answer(saved, "saveWorkshopAssembly").revision, 3);
    const afterSave = await getWorkshopProject(db, id);
    assert.deepEqual(afterSave.assembly.items.map((item) => [item.number, item.kind, item.uses.length]), [["SNY-1-A", "assembly", 1], ["SNY-1-PCB", "pcb", 0]]);
    assert.deepEqual(afterSave.assembly.items[0].uses[0].position, [0, 0, 2]);
    // The assembly's own rules still hold: a part cannot contain other items.
    const broken = { ...assembly, items: [assembly.items[1], { ...assembly.items[0], kind: "printed" }] };
    assert.match((await run(writer, "SaveWorkshopAssembly", { id, revision: 3, assembly: broken })).errors?.[0]?.message ?? "", /Only an assembly contains other items/);

    // Linking after the fact, and unlinking with null.
    const other = crypto.randomUUID();
    const linked = await run(writer, "NameWorkshopProductRevision", { id, revision: 3, productRevision: { id: other, title: "SNY-1 rev B", url: `https://wiki.example/records/${other}` } });
    assert.deepEqual([answer(linked, "nameWorkshopProductRevision").productRevisionId, answer(linked, "nameWorkshopProductRevision").revision], [other, 4]);
    const unlinked = await run(writer, "NameWorkshopProductRevision", { id, revision: 4, productRevision: null });
    assert.equal(answer(unlinked, "nameWorkshopProductRevision").productRevisionId, null);
    assert.equal((await getWorkshopProject(db, id)).productRevision, undefined);
    assert.deepEqual((await run(writer, "NameWorkshopProductRevision", { id: crypto.randomUUID(), revision: 1, productRevision: null })).errors?.[0]?.extensions, { code: "REFUSED", status: 404 });
  } finally { close(); }
});


test("the saved assembly is returned whole, and only one writer can replace its revision", async () => {
  const { db, close } = await workshopDatabase();
  try {
    const context = member(db);
    const { createWorkshopProject: project } = await runDocument(documents.CreateWorkshopProject.document, { input: { example: "node" } }, context);
    const projectId = project.id;
    const read = () => runDocument(documents.WorkshopAssembly.document, { projectId }, context);
    const before = await read();
    const saved = await getWorkshopProject(db, projectId);
    assert.deepEqual({ ...before.workshopAssembly }, { projectId, revision: saved.revision, assembly: saved.assembly });
    const next = structuredClone(saved.assembly);
    for (const item of next.items) item.notes = "first edit".repeat(200);
    const part = next.items.find(item => item.kind === "cots")!;
    while (next.items.length < 204) {
      next.items.push({ ...part, id: crypto.randomUUID(), number: `TEST-${next.items.length}`, notes: "" });
    }
    const replace = (assembly: typeof next) => runDocument(documents.UpdateWorkshopAssembly.document,
      { projectId, expectedRevision: saved.revision, assembly }, context);
    await assert.rejects(replace({ ...next, rootId: crypto.randomUUID() }), status(400));
    const writes = await Promise.allSettled([replace(next), replace(next)]);
    assert.equal(writes.filter(write => write.status === "fulfilled").length, 1);
    assert.ok(writes.some(write => write.status === "rejected" && status(409)(write.reason)));
    assert.deepEqual({ ...(await read()).workshopAssembly }, { projectId, revision: saved.revision + 1, assembly: next });
    const limited = await serveGraphql({ schema: graphqlSchema, query: documentText(documents.WorkshopAssembly.document),
      variables: { projectId }, context, maxBytes: 8192 });
    assert.equal(limited.data, null);
    assert.equal(limited.errors?.[0].extensions?.code, "RESPONSE_TOO_LARGE");
  } finally { close(); }
});

test("a shared gripper propagates through two configurations and a nested consumer without republishing", async () => {
  const {db,close}=await workshopDatabase();
  try {
    const ctx=member(db);
    const create=async(name:string)=>(await runDocument(documents.CreateWorkshopProject.document,{input:{example:"cube",name}},ctx)).createWorkshopProject;
    const save=(projectId:string,expectedRevision:number,assembly:unknown)=>runDocument(documents.UpdateWorkshopAssembly.document,{projectId,expectedRevision,assembly:AssemblySchema.parse(assembly)},ctx);
    const view=async(projectId:string)=>(await runDocument(documents.ResolvedWorkshopAssembly.document,{input:{projectId}},ctx)).resolvedWorkshopAssembly as import("../src/lib/assembly-resolution").ResolvedAssembly;
    const projects=[];
    for(const name of ["Arm","Rack","Compact","Ship","Pin"])projects.push(await create(name));
    const [a,r,c,s,p]=projects;
    const item=(number:string,kind="assembly")=>({id:crypto.randomUUID(),number,kind,name:number,revision:"A"});
    const use=(itemId:string,quantity=1)=>({id:crypto.randomUUID(),itemId,quantity,position:[0,0,0]});
    const root=item("Arm"), grip=item("Gripper","cots"), placement=use(grip.id,2);
    const configuration=(name:string,spacing:number)=>({name,rootId:root.id,parameters:[{name:"gap",min:0,max:100,defaultValue:spacing,placements:[{parentId:root.id,usageId:placement.id,axis:"x",offset:1,scale:2}]}]});
    const structure={rootId:root.id,configurations:[configuration("rack",10),configuration("compact",5)],
      power:{version:1,notes:"",scenarios:[{id:"on",name:"On",notes:""}],rails:[{id:"dc",name:"Input",voltage:24,efficiency:1,kind:"dc",notes:""}]},
      items:[{...root,uses:[placement]},{...grip,power:{loads:[{id:"motor",name:"Motor",rail:"dc",source:"Test",evidence:"assumed",notes:"",scenarios:{on:{averageW:2,operatingW:2,peakW:2}}}]}}]};
    await save(a.id,1,structure);
    const link=(projectId:string,configuration?:string,revision?:number,parameters?:Record<string,number>)=>{
      const wrapper=item("Linked");return {rootId:wrapper.id,items:[{...wrapper,reference:{projectId,...(configuration&&{configuration}),...(revision&&{revision}),...(parameters&&{parameters})}}]};
    };
    await save(r.id,1,link(a.id,"rack"));
    await save(c.id,1,link(a.id,"compact",undefined,{gap:3}));
    await save(s.id,1,link(r.id));
    await save(p.id,1,link(a.id,"rack",2));
    const {powerRollup}=await import("../src/lib/power");
    const {bomTotals}=await import("../src/lib/assembly");
    const check=async(id:string,position:number,watts:number)=>{
      const result=await view(id);
      assert.deepEqual(result,JSON.parse(JSON.stringify(result)), "MCP action results must contain only JSON values");
      assert.equal(result.revision,2);
      assert.equal(result.assembly.items.find(i=>i.number==="Arm")!.uses[0].position[0],position);
      assert.equal(bomTotals(result.assembly).lines.find(l=>l.item.number==="Gripper")!.quantity,2);
      assert.equal(powerRollup(result.assembly,"on")!.total.operatingW,watts);
      return result;
    };
    await check(s.id,21,4);
    await assert.rejects(save(a.id,2,link(s.id)),status(400));
    await assert.rejects(save(c.id,2,link(a.id,"compact",undefined,{gap:101})),status(400));
    const motor=structure.items[1];
    assert.ok('power' in motor);
    const load=motor.power.loads[0];
    load.scenarios.on={averageW:3,operatingW:3,peakW:3};
    await save(a.id,2,structure);
    await check(r.id,21,6);await check(c.id,7,6);await check(s.id,21,6);await check(p.id,21,4);
    // A metadata-only save archives a marker; a later geometry edit supplies its historical body.
    await runDocument(documents.DescribeWorkshopProject.document,{input:{id:a.id,revision:3,brief:"Metadata update"}},ctx);
    load.scenarios.on={averageW:5,operatingW:5,peakW:5};
    await save(a.id,4,structure);
    const archived=(await runDocument(documents.ResolvedWorkshopAssembly.document,{input:{projectId:a.id,revision:3}},ctx)).resolvedWorkshopAssembly as import("../src/lib/assembly-resolution").ResolvedAssembly;
    assert.equal(archived.revision,3);
    assert.equal(powerRollup(archived.assembly,"on")!.total.operatingW,6);
    const both=item("Both"),left={...item("Rack mount"),reference:{projectId:r.id}},right={...item("Compact mount"),reference:{projectId:c.id}};
    await save(s.id,2,{rootId:both.id,items:[{...both,uses:[use(left.id),use(right.id)]},left,right]});
    const grippers=bomTotals((await view(s.id)).assembly).lines.filter(l=>l.item.number==="Gripper");
    assert.deepEqual(grippers.map(l=>l.quantity),[4]);
    assert.equal((await getWorkshopProject(db,r.id)).assembly.items.length,1);
  } finally {close();}
});

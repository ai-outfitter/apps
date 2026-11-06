import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { documents, runDocument } from "../src/server/documents";
import { graphqlSchema, type WorkshopContext } from "../src/server/graphql";
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

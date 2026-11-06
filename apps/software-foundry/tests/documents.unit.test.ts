import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createClient, type InValue } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { print } from "graphql";
import { mutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { migrateAppDatabase } from "@ai-outfitter/app-sdk/migrations";
import { documents, runDocument } from "../src/server/documents";
import { type FoundryContext, graphqlSchema } from "../src/server/graphql";

// Each mutation document runs through graph.mutate as the platform's graph_mutate calls it:
// editors reach the field, a read-only member is refused before it, invalid input is a
// BAD_USER_INPUT error, and a field's own refusal keeps its status. Submissions that reach
// GitHub are covered by intake.integration.test.ts through the same domain function.
const status = (code: number) => (error: unknown) => error instanceof Response && error.status === code;
const mutate = mutateAction(graphqlSchema);
const run = (context: FoundryContext, name: keyof typeof documents, input: unknown) => {
  const document = documents[name].document;
  return mutate.invoke(context, { query: typeof document === "string" ? document : print(document), operationName: name, variables: { input } }) as Promise<{ data: Record<string, unknown> | null; errors?: { message: string; extensions?: Record<string, unknown> }[] }>;
};

async function foundryDatabase() {
  const client = createClient({ url: ":memory:" });
  const directory = new URL("../migrations/", import.meta.url);
  const migrations = await Promise.all((await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()
    .map(async (file) => ({ name: file.slice(0, -4), sql: await readFile(new URL(file, directory), "utf8") })));
  await migrateAppDatabase({
    query: async (sql) => (await client.execute(sql)).rows as Record<string, unknown>[],
    batch: async (statements) => { await client.batch(statements.map((sql) => ({ sql, args: [] as InValue[] })), "write"); },
  }, migrations);
  return { db: drizzle(client), close: () => client.close() };
}
const caller = (db: ReturnType<typeof drizzle>, canEdit: boolean, owner: "organization" | "user" = "organization"): FoundryContext => {
  const actor = { kind: "user" as const, id: "u1" };
  return {
    identity: { userId: "u1", organizationId: owner === "organization" ? "org" : undefined, owner: { kind: owner, id: owner === "organization" ? "org" : "u1" }, installationId: "foundry", role: canEdit ? "owner" : "member", canEdit },
    actor, originActor: actor, db: () => db, origin: "https://foundry.example",
    host: () => { throw new Response("No host in this test", { status: 503 }); },
  } as unknown as FoundryContext;
};

test("CreateProject: the projects page and agents add a project through one document", async () => {
  const { db, close } = await foundryDatabase();
  try {
    const editor = caller(db, true);
    const created = await run(editor, "CreateProject", { name: "outfitter  app", repositories: ["Alpha/Web", "alpha/api", "alpha/web"] });
    assert.equal(created.errors, undefined);
    assert.deepEqual({ ...created.data?.createProject as object, id: "x", updatedAt: "t" }, { id: "x", name: "OUTFITTER APP", position: 0, repositories: ["alpha/web", "alpha/api"], milestones: [], revision: 1, updatedAt: "t" });
    // A duplicate name is the field's own refusal, with its status.
    const duplicate = await run(editor, "CreateProject", { name: "Outfitter App" });
    assert.deepEqual(duplicate.errors?.[0]?.extensions, { code: "REFUSED", status: 409 });
    // The zod schema still validates after the GraphQL type admits the shape.
    const invalid = await run(editor, "CreateProject", { name: "", repositories: [] });
    assert.equal(invalid.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
    assert.equal((await run(editor, "CreateProject", { name: "docs", repositories: ["not a repository"] })).errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
    // A field the document's input type lacks never reaches the resolver.
    assert.match((await run(editor, "CreateProject", { name: "docs", extra: true })).errors?.[0]?.message ?? "", /extra/);
    // graph.mutate refuses a read-only member before any field runs.
    await assert.rejects(run(caller(db, false), "CreateProject", { name: "docs" }), status(403));

    // The route runs the same document in process: a refusal is the Response it would have thrown,
    // invalid input (zod, or a variable the document's type rejects) an opaque 400.
    const page = await runDocument(documents.CreateProject.document, { input: { name: "docs", repositories: ["alpha/web"] } }, editor);
    assert.deepEqual([page.createProject.name, page.createProject.position], ["DOCS", 1]);
    await assert.rejects(runDocument(documents.CreateProject.document, { input: { name: "docs" } }, caller(db, false)), status(403));
    await assert.rejects(runDocument(documents.CreateProject.document, { input: { name: "" } }, editor), status(400));
    const coerced = await runDocument(documents.CreateProject.document, { input: { name: "docs", extra: true } as never }, editor).then(() => null, (error: unknown) => error);
    assert.ok(status(400)(coerced));
    assert.equal(await (coerced as Response).text(), "Invalid input");
    await assert.rejects(runDocument(documents.CreateProject.document, { input: { name: "docs" } }, editor), status(409));
    // An unexpected failure inside a field is not the caller's: it is rethrown for the route's 500, as before.
    const broken = { ...editor, db: () => { throw new Error("database unavailable"); } } as FoundryContext;
    await assert.rejects(runDocument(documents.CreateProject.document, { input: { name: "api" } }, broken),
      (error: unknown) => error instanceof Error && !(error instanceof Response) && /createProject: database unavailable/.test(error.message));
  } finally { close(); }
});

test("SubmitWork and StartWork gate and validate as their actions do before touching the host", async () => {
  const { db, close } = await foundryDatabase();
  try {
    const submission = { target: { project: "missing" }, requestId: "aaaaaaaa-1111-4111-8111-111111111111", title: "Work", description: "Description", acceptanceCriteria: ["Done"] };
    await assert.rejects(run(caller(db, false), "SubmitWork", submission), status(403));
    assert.equal((await run(caller(db, true), "SubmitWork", { ...submission, requestId: "not-a-uuid" })).errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
    assert.equal((await run(caller(db, true), "SubmitWork", { ...submission, target: {} })).errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
    // An editor reaches submitWork itself: the unknown project is its refusal, raised before any host call.
    const missing = await run(caller(db, true), "SubmitWork", submission);
    assert.deepEqual([missing.errors?.[0]?.message, missing.errors?.[0]?.extensions], ["Foundry project not found", { code: "REFUSED", status: 409 }]);

    const start = { requestId: "bbbbbbbb-1111-4111-8111-111111111111", target: { repository: "acme/app" }, root: { ref: { installationId: "wiki", type: "graph-node", id: "story" }, revision: 1 } };
    await assert.rejects(run(caller(db, false), "StartWork", start), status(403));
    assert.equal((await run(caller(db, true), "StartWork", { ...start, root: { ...start.root, revision: 0 } })).errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
    // startWork's own gate: an editor of a personal installation is refused by the field.
    const personal = await run(caller(db, true, "user"), "StartWork", start);
    assert.deepEqual(personal.errors?.[0]?.extensions, { code: "REFUSED", status: 403 });
    // An organization editor reaches startWork, which asks the host for the Wiki first.
    assert.deepEqual((await run(caller(db, true), "StartWork", start)).errors?.[0]?.extensions, { code: "REFUSED", status: 503 });
  } finally { close(); }
});

test("RequestFeature gates and validates before touching the host", async () => {
  const { db, close } = await foundryDatabase();
  try {
    const request = { requestId: "cccccccc-1111-4111-8111-111111111111", target: { repository: "acme/app" }, title: "Export", problem: "Rebuilt by hand", requestedChange: "Export the selection", acceptanceCriteria: ["The file holds the selection"] };
    await assert.rejects(run(caller(db, false), "RequestFeature", request), status(403));
    for (const invalid of [{ problem: " " }, { acceptanceCriteria: [] }, { target: {} }, { requestId: "not-a-uuid" }, { title: "x".repeat(161) },
      { relatedNodes: [{ ref: { installationId: "wiki", type: "graph-edge", id: "e" }, revision: 1 }] }])
      assert.equal((await run(caller(db, true), "RequestFeature", { ...request, ...invalid })).errors?.[0]?.extensions?.code, "BAD_USER_INPUT", JSON.stringify(invalid));
    // The field's own gate: a personal installation, or a request an app started on its own.
    assert.deepEqual((await run(caller(db, true, "user"), "RequestFeature", request)).errors?.[0]?.extensions, { code: "REFUSED", status: 403 });
    const app = { ...caller(db, true), originActor: { kind: "app", id: "planning" } } as FoundryContext;
    assert.deepEqual((await run(app, "RequestFeature", request)).errors?.[0]?.extensions, { code: "REFUSED", status: 403 });
    // An organization editor reaches requestFeature, which asks the host for the organization first.
    assert.deepEqual((await run(caller(db, true), "RequestFeature", request)).errors?.[0]?.extensions, { code: "REFUSED", status: 503 });
  } finally { close(); }
});

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

test("RequestChanges validates a feature or bug strictly, then files it through submitWork", async () => {
  const { db, close } = await foundryDatabase();
  try {
    const submit = (context: FoundryContext, input: unknown) => mutate.invoke(context, {
      query: "mutation Submit($input: SubmitRequestInput!) { submitRequest(input: $input) { id kind issue { url } } }",
      operationName: "Submit", variables: { input },
    }) as Promise<{ data: Record<string, unknown> | null; errors?: { message: string; extensions?: Record<string, unknown> }[] }>;
    const request = { kind: "bug", requestId: "cccccccc-1111-4111-8111-111111111111", target: { project: "missing" }, title: "Export drops rows", problem: "Exports lose a row.", acceptanceCriteria: [{ id: "all-rows", text: "The file holds every selected row" }],
      bug: { stepsToReproduce: ["Select 3 rows", "Export"], expected: "3 rows", actual: "2 rows" } };
    await assert.rejects(submit(caller(db, false), request), status(403));
    for (const invalid of [{ kind: "chore" }, { kind: undefined }, { kind: "feature" }, { bug: undefined }, { problem: "" }, { acceptanceCriteria: [] }, { acceptanceCriteria: ["untyped"] },
      { acceptanceCriteria: [{ id: "a", text: "x" }, { id: "a", text: "y" }] }, { target: {} }, { requestId: "not-a-uuid" }, { title: "x".repeat(201) }, { extra: true }])
      assert.ok(await submit(caller(db, true), { ...request, ...invalid }).then((result) => result.errors?.length, status(400)), JSON.stringify(invalid));
    // An editor reaches submitWork: the unknown project is its refusal, raised before any host call.
    const missing = await submit(caller(db, true), request);
    assert.deepEqual([missing.errors?.[0]?.message, missing.errors?.[0]?.extensions], ["Foundry project not found", { code: "REFUSED", status: 409 }]);
    // The request is recorded once; the same requestId with changed content conflicts.
    const changed = await submit(caller(db, true), { ...request, title: "Something else" });
    assert.deepEqual(changed.errors?.[0]?.extensions, { code: "REFUSED", status: 409 });
    const { readRequests, requestReadInput } = await import("../src/server/requests");
    assert.deepEqual((await readRequests(caller(db, true), requestReadInput.parse({}))).nodes, [{ id: request.requestId, kind: "bug", title: "Export drops rows", issueUrl: null }]);
  } finally { close(); }
});

test("A request renders its kind, problem and bug details into the issue description", async () => {
  const { requestDescription, requestInput } = await import("../src/server/requests");
  const base = { requestId: "DDDDDDDD-1111-4111-8111-111111111111", target: { repository: "acme/app" }, title: "T", problem: "P", acceptanceCriteria: [{ id: "a", text: "A" }] };
  const feature = requestInput.parse({ ...base, kind: "feature" });
  assert.equal(feature.requestId, "dddddddd-1111-4111-8111-111111111111");
  assert.equal(requestDescription(feature), "**Kind:** feature\n\nP");
  assert.equal(requestDescription(requestInput.parse({ ...base, kind: "bug", bug: { stepsToReproduce: ["Open", "Click"], expected: "E", actual: "X" } })),
    "**Kind:** bug\n\nP\n\n## Steps to reproduce\n1. Open\n2. Click\n\n## Expected\nE\n\n## Actual\nX");
});

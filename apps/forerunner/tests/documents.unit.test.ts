import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { ForerunnerContext } from "../src/server/context";
import { documents, runDocument } from "../src/server/documents";
import { graphqlSchema } from "../src/server/graphql";
import { type Database, listItems } from "../src/server/items";

// Each mutation document runs through graph.mutate as the platform's graph_mutate calls it,
// with the gate the actions route mounts: every member writes their own board, invalid input
// is a BAD_USER_INPUT error, and a field's own refusal (another member's item, a stale
// revision, a non-editor changing the daily run) keeps its status. The routes run the same
// documents in process through runDocument.
const status = (code: number) => (error: unknown) => error instanceof Response && error.status === code;
const mutate = mutateAction(graphqlSchema, { canInvoke: () => true });
type Result = { data: Record<string, Record<string, unknown>> | null; errors?: { message: string; extensions?: Record<string, unknown> }[] };
const run = (context: ForerunnerContext, name: Exclude<keyof typeof documents, "Board">, input: unknown) =>
  mutate.invoke(context, { query: documentText(documents[name].document), operationName: name, variables: { input } }) as Promise<Result>;
const code = (result: Result) => result.errors?.[0]?.extensions?.code;

async function database() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return { db, close: () => client.close() };
}
const connection = { id: "c0000000-0000-4000-8000-000000000001", provider: "gmail", resource: "alice@example.test", label: "Alice", operations: ["messages.list", "messages.get"] };
/** A member of a personal installation; `canEdit` is false for an ordinary organization member. */
function caller(db: Database, userId: string, canEdit: boolean, saved: Record<string, unknown>[] = []): ForerunnerContext {
  const actor = { kind: "member" as const, id: userId };
  const host = {
    call: async (name: string, input: Record<string, unknown>) => {
      if (name === "snapshot") return { connections: [connection] };
      if (name === "schedule.save") { saved.push(input); return {}; }
      if (name === "schedules") return saved.length ? [{ workflowId: "forerunner-discovery", enabled: saved.at(-1)?.enabled, connectionId: connection.id, timezone: "Europe/London", nextRunAt: 5, lastRunAt: null, lastOutcome: null }] : [];
      throw new Error(name);
    },
  } as unknown as WorkflowHost<"interactive">;
  return {
    identity: { userId, installationId: "forerunner", owner: { kind: "user", id: "alice" }, role: canEdit ? "owner" : "member", canEdit },
    actor, originActor: actor, db: () => db, host: () => host,
  };
}
const stone = (title: string) => ({ category: "stone" as const, title, description: "", dueDate: null, status: "todo", parentId: null });

test("the board's documents write a member's own items through graph.mutate, revision-checked", async () => {
  const { db, close } = await database();
  try {
    const alice = caller(db, "alice", false);
    const created = await run(alice, "CreateItem", stone("Launch"));
    assert.equal(created.errors, undefined);
    const launch = created.data?.createItem as { id: string; revision: number; position: number; updatedAt: string };
    assert.deepEqual([launch.position, launch.revision, typeof launch.updatedAt], [1, 1, "string"]);
    // A pebble needs one of the caller's stones: the field's own 400.
    assert.deepEqual((await run(alice, "CreateItem", { ...stone("Orphan"), category: "pebble", parentId: "a0000000-0000-4000-8000-000000000000" })).errors?.[0]?.extensions, { code: "REFUSED", status: 400 });
    // zod still validates after the GraphQL type admits the shape; a field the type lacks never reaches it.
    assert.equal(code(await run(alice, "CreateItem", { ...stone("Orphan"), category: "pebble" })), "BAD_USER_INPUT");
    assert.equal(code(await run(alice, "CreateItem", stone("   "))), "BAD_USER_INPUT");
    assert.equal(code(await run(alice, "CreateItem", { ...stone("Dated"), dueDate: "2026-02-30" })), "BAD_USER_INPUT");
    assert.match((await run(alice, "CreateItem", { ...stone("Extra"), ownerId: "bob" })).errors?.[0]?.message ?? "", /ownerId/);

    const done = await run(alice, "UpdateItem", { ...stone("Launch"), id: launch.id, status: "done", revision: 1 });
    assert.deepEqual([done.data?.updateItem.status, done.data?.updateItem.revision], ["done", 2]);
    assert.deepEqual((await run(alice, "UpdateItem", { ...stone("Stale"), id: launch.id, revision: 1 })).errors?.[0]?.extensions, { code: "REFUSED", status: 409 });
    assert.equal(code(await run(alice, "UpdateItem", { ...stone("Bad id"), id: "launch", revision: 2 })), "BAD_USER_INPUT");

    // Another member, editor or not, finds nothing of Alice's: the same 404 as a missing item.
    const bob = caller(db, "bob", true);
    assert.deepEqual((await run(bob, "UpdateItem", { ...stone("Stolen"), id: launch.id, revision: 2 })).errors?.[0]?.extensions, { code: "REFUSED", status: 404 });
    assert.deepEqual((await run(bob, "DeleteItem", { id: launch.id, revision: 2 })).errors?.[0]?.extensions, { code: "REFUSED", status: 404 });

    const second = (await run(alice, "CreateItem", stone("Second"))).data?.createItem as { id: string };
    const reordered = await run(alice, "ReorderItems", { items: [{ id: second.id, revision: 1 }, { id: launch.id, revision: 2 }] });
    const order = (reordered.data?.reorderItems ?? []) as { id: string; position: number; revision: number }[];
    assert.deepEqual(order.map((row) => [row.id, row.position, row.revision]), [[second.id, 1, 2], [launch.id, 2, 3]]);
    assert.deepEqual((await run(alice, "ReorderItems", { items: [{ id: second.id, revision: 1 }, { id: launch.id, revision: 3 }] })).errors?.[0]?.extensions, { code: "REFUSED", status: 409 });
    assert.equal(code(await run(alice, "ReorderItems", { items: [{ id: second.id, revision: 2 }] })), "BAD_USER_INPUT");

    assert.deepEqual((await run(alice, "DeleteItem", { id: launch.id, revision: 3 })).data, { deleteItem: { deleted: launch.id } });
    assert.deepEqual((await listItems(db, alice.identity)).map((row) => row.id), [second.id]);
  } finally { close(); }
});

test("SetDailyRun saves the schedule for an editor and refuses a member before touching the host", async () => {
  const { db, close } = await database();
  try {
    const saved: Record<string, unknown>[] = [];
    const editor = caller(db, "alice", true, saved);
    const on = await run(editor, "SetDailyRun", { enabled: true, source: `connection:${connection.id}`, timezone: "Europe/London" });
    assert.deepEqual(on.data, { setDailyRun: { enabled: true, connectionId: connection.id, timezone: "Europe/London", nextRunAt: 5, lastRunAt: null, lastOutcome: null } });
    assert.deepEqual(saved[0], { workflow: "forerunner-discovery", timezone: "Europe/London", enabled: true, connectionId: connection.id, resource: connection.resource, inputs: { "analyze.inputs.provider": "gmail", "analyze.inputs.label": "Alice" } });
    assert.equal(code(await run(editor, "SetDailyRun", { enabled: true, source: "mailbox", timezone: "Europe/London" })), "BAD_USER_INPUT");
    assert.equal(code(await run(editor, "SetDailyRun", { enabled: true, timezone: "Mars/Olympus" })), "BAD_USER_INPUT");
    // Turning it on without naming an account is the field's own 400.
    assert.deepEqual((await run(editor, "SetDailyRun", { enabled: true })).errors?.[0]?.extensions, { code: "REFUSED", status: 400 });
    const member = await run(caller(db, "alice", false, saved), "SetDailyRun", { enabled: false });
    assert.deepEqual([member.errors?.[0]?.extensions, saved.length], [{ code: "REFUSED", status: 403 }, 1]);
  } finally { close(); }
});

test("a route runs the same document in process and answers as it did before documents", async () => {
  const { db, close } = await database();
  try {
    const alice = caller(db, "alice", false);
    const { createItem } = await runDocument(documents.CreateItem.document, { input: stone("Launch") }, alice);
    assert.equal(createItem.title, "Launch");
    // A refusal is the Response the route would have thrown; invalid input (zod, or a variable the document's type rejects) an opaque 400.
    await assert.rejects(runDocument(documents.UpdateItem.document, { input: { ...stone("Stale"), id: createItem.id, revision: 9 } }, alice), status(409));
    await assert.rejects(runDocument(documents.DeleteItem.document, { input: { id: createItem.id, revision: 1 } }, caller(db, "bob", true)), status(404));
    await assert.rejects(runDocument(documents.CreateItem.document, { input: stone("") }, alice), status(400));
    const coerced = await runDocument(documents.CreateItem.document, { input: { ...stone("Extra"), extra: true } as never }, alice).then(() => null, (error: unknown) => error);
    assert.ok(status(400)(coerced));
    assert.equal(await (coerced as Response).text(), "Invalid input");
    await assert.rejects(runDocument(documents.SetDailyRun.document, { input: { enabled: false } }, alice), status(403));
    // An unexpected failure inside a field is not the caller's: it is rethrown for the route's 500, as before.
    const broken = { ...alice, db: () => { throw new Error("database unavailable"); } };
    await assert.rejects(runDocument(documents.CreateItem.document, { input: stone("Later") }, broken),
      (error: unknown) => error instanceof Error && !(error instanceof Response) && /createItem: database unavailable/.test(error.message));
  } finally { close(); }
});

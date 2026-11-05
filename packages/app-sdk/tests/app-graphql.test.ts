import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { GraphQLObjectType, GraphQLSchema, GraphQLString, printSchema } from "graphql";
import { graphGraphqlResult, graphqlAction, serveGraphql, tableType } from "../src/app-graphql";

// An app's own table, served the way a Wiki serves its records.
const items = sqliteTable("items", {
  id: text().primaryKey(),
  title: text().notNull(),
  status: text().notNull(),
  body: text().notNull().default(""),
  receivedAt: integer().notNull(),
  secret: text(),
});
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: tableType(items, { field: "items", type: "Item", fields: ["title", "status", "body", "receivedAt"], dates: ["receivedAt"], filters: ["status"] }),
  }),
});

async function database(count: number, body = "") {
  const client = createClient({ url: ":memory:" });
  await client.execute("CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', receivedAt INTEGER NOT NULL, secret TEXT)");
  const db = drizzle(client);
  for (let n = 0; n < count; n += 100)
    await db.insert(items).values(Array.from({ length: Math.min(100, count - n) }, (_, i) => {
      const index = n + i;
      return { id: `i-${String(index).padStart(4, "0")}`, title: `Item ${index}`, status: index % 2 ? "open" : "closed", body, receivedAt: 1_762_000_000_000 + index, secret: "never" };
    }));
  return db;
}
const serve = async (db: Awaited<ReturnType<typeof database>>, query: string, extra: { variables?: Record<string, unknown>; maxBytes?: number } = {}) =>
  graphGraphqlResult.parse(await serveGraphql({ schema, query, ...extra, context: { db: () => db } }));

test("a table serves ID-ordered pages with ids and column filters, and only the chosen columns", async () => {
  const db = await database(5);
  const sdl = printSchema(schema);
  assert.match(sdl, /items\(first: Int = 100, after: String, ids: \[ID!\], status: \[String!\]\): ItemConnection!/);
  assert.match(sdl, /receivedAt: DateTime!/);
  assert.doesNotMatch(sdl, /secret/);
  const first = await serve(db, `{ items(first: 2, status: ["open"]) { nodes { id title receivedAt } pageInfo { endCursor hasNextPage } aggregate { count } } }`);
  const page = (first.data as { items: { nodes: { id: string; receivedAt: string }[]; pageInfo: { endCursor: string; hasNextPage: boolean }; aggregate: { count: number } } }).items;
  assert.deepEqual(page.nodes.map(node => node.id), ["i-0001", "i-0003"]);
  assert.equal(page.nodes[0].receivedAt, new Date(1_762_000_000_001).toISOString());
  assert.deepEqual([page.pageInfo.hasNextPage, page.aggregate.count], [false, 2]);
  const next = await serve(db, `query($after: String) { items(first: 2, after: $after) { nodes { id } pageInfo { hasNextPage } } }`, { variables: { after: page.pageInfo.endCursor } });
  assert.deepEqual(next.data, { items: { nodes: [{ id: "i-0004" }], pageInfo: { hasNextPage: false } } });
  const ids = await serve(db, `{ items(ids: ["i-0002", "i-0000", "missing"]) { nodes { id } } }`);
  assert.deepEqual(ids.data, { items: { nodes: [{ id: "i-0000" }, { id: "i-0002" }] } });
  const refused = await serve(db, `{ items(first: 501) { nodes { id } } }`);
  assert.equal(refused.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  const hidden = await serve(db, `{ items { nodes { secret } } }`);
  assert.equal(hidden.errors?.[0]?.extensions?.code, "GRAPHQL_VALIDATION_FAILED");
  // A column holding another record's ID is served and filtered as ID.
  const referencing = printSchema(new GraphQLSchema({
    query: new GraphQLObjectType({ name: "Query", fields: tableType(items, { field: "items", type: "Item", fields: ["status"], ids: ["status"], filters: ["status"] }) }),
  }));
  assert.match(referencing, /status: \[ID!\]\): ItemConnection!/);
  assert.match(referencing, /status: ID!/);
});

test("an app's schema keeps the Wiki's limits: depth, fields and maxBytes cut lists, never records", async () => {
  const db = await database(60, "b".repeat(400));
  const result = await serve(db, `{ items { nodes { id body } page: pageInfo { endCursor hasNextPage } aggregate { count } } }`, { maxBytes: 8192 });
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= 8192);
  const items = (result.data as { items: { nodes: { id: string; body: string }[]; page: { endCursor: string; hasNextPage: boolean }; aggregate: { count: number } } }).items;
  assert.ok(items.nodes.length > 0 && items.nodes.length < 60);
  assert.ok(items.nodes.every(node => node.body.length === 400));
  assert.deepEqual([items.page.hasNextPage, items.aggregate.count], [true, 60]);
  assert.deepEqual([result.extensions?.truncated, result.extensions?.truncatedPaths], [true, [["items", "nodes"]]]);
  const next = await serve(db, `query($after: String) { items(after: $after) { nodes { id } } }`, { variables: { after: items.page.endCursor } });
  assert.equal((next.data as { items: { nodes: { id: string }[] } }).items.nodes[0].id, `i-${String(items.nodes.length).padStart(4, "0")}`, "the cut page continues where it stopped");

  // A page whose rows resolve to more than the request may hold is cut, not refused.
  const large = await database(500, "b".repeat(1000));
  const cut = await serve(large, `{ items(first: 500) { nodes { id body } pageInfo { endCursor hasNextPage } } }`);
  const cutItems = (cut.data as { items: { nodes: { id: string }[]; pageInfo: { endCursor: string; hasNextPage: boolean } } }).items;
  assert.ok(cutItems.nodes.length > 0 && cutItems.nodes.length < 500 && cutItems.pageInfo.hasNextPage);
  assert.deepEqual([cut.extensions?.truncated, cut.extensions?.truncatedPaths], [true, [["items", "nodes"]]]);
  const after = await serve(large, `query($after: String) { items(first: 1, after: $after) { nodes { id } } }`, { variables: { after: cutItems.pageInfo.endCursor } });
  assert.deepEqual(after.data, { items: { nodes: [{ id: `i-${String(cutItems.nodes.length).padStart(4, "0")}` }] } });

  const aliases = Array.from({ length: 1900 }, (_, n) => `a${n}: body`).join(" ");
  const exploded = await serve(db, `{ items(first: 60) { nodes { ${aliases} } } }`);
  assert.deepEqual([exploded.data, exploded.errors?.[0]?.extensions?.code], [null, "RESPONSE_TOO_LARGE"]);
  const fields = await serve(db, `{ items { nodes { ${Array.from({ length: 2001 }, (_, n) => `f${n}: id`).join(" ")} } } }`);
  assert.equal(fields.errors?.[0]?.extensions?.code, "QUERY_TOO_COMPLEX");

  const nested: GraphQLObjectType = new GraphQLObjectType({ name: "Nested", fields: () => ({ value: { type: GraphQLString }, nested: { type: nested, resolve: () => ({}) } }) });
  const deep = graphGraphqlResult.parse(await serveGraphql({
    schema: new GraphQLSchema({ query: new GraphQLObjectType({ name: "Query", fields: { nested: { type: nested, resolve: () => ({}) } } }) }),
    query: `{ nested { nested { nested { nested { nested { nested { nested { nested { value } } } } } } } } }`,
  }));
  assert.equal(deep.errors?.[0]?.extensions?.code, "QUERY_TOO_DEEP");
});

test("scope narrows every read of a table, and serves nothing when it answers undefined", async () => {
  const db = await database(6);
  // Stands in for "the caller's own rows": a signed-in caller reads the open items only.
  const scoped = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: tableType(items, { field: "items", type: "Item", fields: ["status"], scope: ({ identity }) => (identity?.userId ? eq(items.status, "open") : undefined) }),
    }),
  });
  const read = async (identity: unknown, query: string) =>
    graphGraphqlResult.parse(await serveGraphql({ schema: scoped, query, context: { db: () => db, identity } })).data;
  assert.deepEqual(await read({ userId: "u" }, `{ items(first: 2) { nodes { id } pageInfo { hasNextPage } aggregate { count } } }`),
    { items: { nodes: [{ id: "i-0001" }, { id: "i-0003" }], pageInfo: { hasNextPage: true }, aggregate: { count: 3 } } });
  assert.deepEqual(await read({ userId: "u" }, `{ items(ids: ["i-0000", "i-0001"]) { nodes { id } aggregate { count } } }`),
    { items: { nodes: [{ id: "i-0001" }], aggregate: { count: 1 } } });
  assert.deepEqual(await read(undefined, `{ items(ids: ["i-0001"]) { nodes { id } pageInfo { endCursor hasNextPage } aggregate { count } } }`),
    { items: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false }, aggregate: { count: 0 } } });
});

test("graphqlAction is a read action with the Wiki's input and result", async () => {
  const action = graphqlAction(schema);
  assert.deepEqual([action.access, action.readOnly], ["read", true]);
  const db = await database(1);
  const identity = { userId: "u", canEdit: false } as never;
  const result = await action.invoke({ identity, actor: {} as never, originActor: {} as never, db: () => db } as never, { query: "{ items { nodes { title } } }" }, true);
  assert.deepEqual(result, { data: { items: { nodes: [{ title: "Item 0" }] } } });
});

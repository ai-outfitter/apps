import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { GraphQLObjectType, GraphQLSchema, GraphQLString, printSchema } from "graphql";
import { graphGraphqlResult, graphqlAction, serveGraphql, tableType } from "../src/app-graphql";
import { matchesFilter } from "../src/graph-filter";
import { filterSql } from "../src/graph-filter-sql";

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
    fields: tableType(items, { field: "items", type: "Item", fields: ["title", "status", "body", "receivedAt"], dates: ["receivedAt"], filters: ["status", "receivedAt", "title"], orders: ["receivedAt", "status"] }),
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
  assert.match(sdl, /items\(\s*first: Int = 100\s+after: String\s+ids: \[ID!\]\s+orderBy: ItemOrder = ID_ASC\s+filter: ItemFilter\s+"""Match text across this collection’s text fields\."""\s+search: String\s*\): ItemConnection!/);
  // The Relay connection shape with PostGraphile's nodes and totalCount, and its filter and order.
  assert.match(sdl, /type ItemConnection \{\s+edges: \[ItemConnectionEdge!\]!\s+nodes: \[Item!\]!\s+pageInfo: PageInfo!\s+totalCount: Int!\s+\}/);
  assert.match(sdl, /type ItemConnectionEdge \{\s+cursor: String!\s+node: Item!\s+\}/);
  assert.match(sdl, /type PageInfo \{\s+hasNextPage: Boolean!\s+hasPreviousPage: Boolean!\s+startCursor: String\s+endCursor: String\s+\}/);
  assert.match(sdl, /input ItemFilter \{\s+status: StringFilter\s+receivedAt: DateTimeFilter\s+title: StringFilter\s+and: \[ItemFilter!\]\s+or: \[ItemFilter!\]\s+not: ItemFilter\s+\}/);
  assert.match(sdl, /enum ItemOrder \{\s+ID_ASC\s+ID_DESC\s+RECEIVED_AT_ASC\s+RECEIVED_AT_DESC\s+STATUS_ASC\s+STATUS_DESC\s+\}/);
  assert.doesNotMatch(sdl, /aggregate|Aggregate/);
  assert.match(sdl, /receivedAt: DateTime!/);
  assert.doesNotMatch(sdl, /secret/);
  const first = await serve(db, `{ items(first: 2, filter: { status: { in: ["open"] } }) { nodes { id title receivedAt } pageInfo { endCursor hasNextPage } totalCount } }`);
  const page = (first.data as { items: { nodes: { id: string; receivedAt: string }[]; pageInfo: { endCursor: string; hasNextPage: boolean }; totalCount: number } }).items;
  assert.deepEqual(page.nodes.map(node => node.id), ["i-0001", "i-0003"]);
  assert.equal(page.nodes[0].receivedAt, new Date(1_762_000_000_001).toISOString());
  assert.deepEqual([page.pageInfo.hasNextPage, page.totalCount], [false, 2]);
  const next = await serve(db, `query($after: String) { items(first: 2, after: $after) { nodes { id } pageInfo { hasNextPage } } }`, { variables: { after: page.pageInfo.endCursor } });
  assert.deepEqual(next.data, { items: { nodes: [{ id: "i-0004" }], pageInfo: { hasNextPage: false } } });
  // Each record's cursor is the one that continues after it; startCursor and endCursor are the page's first and last.
  const edges = await serve(db, `query($after: String) { items(first: 2, after: $after) { edges { cursor node { id } } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } } }`, { variables: { after: page.pageInfo.endCursor } });
  const edgePage = (edges.data as { items: { edges: { cursor: string; node: { id: string } }[]; pageInfo: Record<string, unknown> } }).items;
  assert.deepEqual(edgePage.edges.map(edge => edge.node.id), ["i-0004"]);
  assert.deepEqual(edgePage.pageInfo, { hasNextPage: false, hasPreviousPage: true, startCursor: edgePage.edges[0].cursor, endCursor: edgePage.edges[0].cursor });
  const start = await serve(db, `{ items(first: 2) { edges { cursor node { id } } pageInfo { hasPreviousPage startCursor endCursor } } }`);
  const startPage = (start.data as { items: { edges: { cursor: string; node: { id: string } }[]; pageInfo: Record<string, unknown> } }).items;
  assert.deepEqual(startPage.pageInfo, { hasPreviousPage: false, startCursor: startPage.edges[0].cursor, endCursor: startPage.edges[1].cursor });
  const fromFirst = await serve(db, `query($after: String) { items(first: 1, after: $after) { nodes { id } } }`, { variables: { after: startPage.edges[0].cursor } });
  assert.deepEqual(fromFirst.data, { items: { nodes: [{ id: "i-0001" }] } });
  // One cursor format: every order's cursor names its order, the default ID_ASC included, and nothing else is a cursor.
  const decoded = JSON.parse(decodeURIComponent(atob(startPage.edges[0].cursor)));
  assert.deepEqual(decoded, ["ID_ASC", "i-0000", "i-0000"]);
  const bare = await serve(db, `query($after: String) { items(after: $after) { nodes { id } } }`, { variables: { after: btoa("i-0000") } });
  assert.deepEqual([bare.errors?.[0]?.message, bare.errors?.[0]?.extensions?.code], ["Invalid cursor", "BAD_USER_INPUT"]);
  // orderBy pages by keyset in the database: a declared column, then the ID; a cursor continues only its own order.
  const ordered = async (orderBy: string, after: string | null = null, first = 2) => {
    const result = await serve(db, `query($orderBy: ItemOrder, $after: String, $first: Int) { items(first: $first, orderBy: $orderBy, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }`, { variables: { orderBy, after, first } });
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    return (result.data as { items: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } }).items;
  };
  const newest = await ordered("RECEIVED_AT_DESC");
  assert.deepEqual(newest.nodes.map(node => node.id), ["i-0004", "i-0003"]);
  assert.deepEqual((await ordered("RECEIVED_AT_DESC", newest.pageInfo.endCursor, 5)).nodes.map(node => node.id), ["i-0002", "i-0001", "i-0000"]);
  const byStatus = await ordered("STATUS_ASC");
  assert.deepEqual(byStatus.nodes.map(node => node.id), ["i-0000", "i-0002"]);
  assert.deepEqual((await ordered("STATUS_ASC", byStatus.pageInfo.endCursor, 5)).nodes.map(node => node.id), ["i-0004", "i-0001", "i-0003"]);
  assert.deepEqual((await ordered("ID_DESC", (await ordered("ID_DESC")).pageInfo.endCursor, 5)).nodes.map(node => node.id), ["i-0002", "i-0001", "i-0000"]);
  // An explicit null is no order given: the default, as when orderBy is left out.
  assert.deepEqual((await serve(db, `{ items(first: 1, orderBy: null) { nodes { id } } }`)).data, { items: { nodes: [{ id: "i-0000" }] } });
  const crossed = await serve(db, `query($after: String) { items(orderBy: STATUS_ASC, after: $after) { nodes { id } } }`, { variables: { after: newest.pageInfo.endCursor } });
  assert.equal(crossed.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  assert.equal((await serve(db, `{ items(first: -1) { nodes { id } } }`)).errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  // filter: connection-filter operators over the declared columns, with and, or and not, compiled to SQL.
  const filtered = async (filter: object) => {
    const result = await serve(db, `query($filter: ItemFilter) { items(filter: $filter) { nodes { id } totalCount } }`, { variables: { filter } });
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    const { nodes, totalCount } = (result.data as { items: { nodes: { id: string }[]; totalCount: number } }).items;
    assert.equal(totalCount, nodes.length);
    return nodes.map(node => node.id.slice(-1)).join("");
  };
  const at = (index: number) => new Date(1_762_000_000_000 + index).toISOString();
  assert.equal(await filtered({ status: { equalTo: "open" } }), "13");
  assert.equal(await filtered({ status: { notEqualTo: "open" }, receivedAt: { greaterThan: at(0) } }), "24");
  assert.equal(await filtered({ receivedAt: { greaterThanOrEqualTo: at(1), lessThan: at(3) } }), "12");
  assert.equal(await filtered({ or: [{ title: { equalTo: "Item 0" } }, { title: { in: ["Item 4", "Item 9"] } }] }), "04");
  assert.equal(await filtered({ not: { status: { in: ["open"] } }, title: { notIn: ["Item 2"] } }), "04");
  assert.equal(await filtered({ title: { startsWith: "Item", includes: "3" } }), "3");
  assert.equal(await filtered({ title: { includesInsensitive: "ITEM 1" } }), "1");
  assert.equal(await filtered({ title: { startsWithInsensitive: "item" }, status: { isNull: false } }), "01234");
  assert.equal(await filtered({ and: [{ status: { isNull: true } }] }), "");
  // A filter larger than one statement may bind is refused, as is a column the table did not declare.
  const tooMany = await serve(db, `query($filter: ItemFilter) { items(filter: $filter) { nodes { id } } }`, { variables: { filter: { or: Array.from({ length: 21 }, (_, n) => ({ title: { equalTo: `Item ${n}` } })) } } });
  assert.match(String(tooMany.errors?.[0]?.message), /21 conditions; at most 20/);
  assert.equal(tooMany.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  assert.equal((await serve(db, `{ items(filter: { body: { equalTo: "" } }) { nodes { id } } }`)).errors?.[0]?.extensions?.code, "GRAPHQL_VALIDATION_FAILED");
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
  assert.match(referencing, /input ItemFilter \{\s+status: IDFilter/);
  assert.match(referencing, /status: ID!/);
});

test("an app's schema keeps the Wiki's limits: depth, fields and maxBytes cut lists, never records", async () => {
  const db = await database(60, "b".repeat(400));
  const result = await serve(db, `{ items { nodes { id body } page: pageInfo { endCursor hasNextPage } totalCount } }`, { maxBytes: 8192 });
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= 8192);
  const items = (result.data as { items: { nodes: { id: string; body: string }[]; page: { endCursor: string; hasNextPage: boolean }; totalCount: number } }).items;
  assert.ok(items.nodes.length > 0 && items.nodes.length < 60);
  assert.ok(items.nodes.every(node => node.body.length === 400));
  assert.deepEqual([items.page.hasNextPage, items.totalCount], [true, 60]);
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
  assert.deepEqual(await read({ userId: "u" }, `{ items(first: 2) { nodes { id } pageInfo { hasNextPage } totalCount } }`),
    { items: { nodes: [{ id: "i-0001" }, { id: "i-0003" }], pageInfo: { hasNextPage: true }, totalCount: 3 } });
  assert.deepEqual(await read({ userId: "u" }, `{ items(ids: ["i-0000", "i-0001"]) { nodes { id } totalCount } }`),
    { items: { nodes: [{ id: "i-0001" }], totalCount: 1 } });
  assert.deepEqual(await read(undefined, `{ items(ids: ["i-0001"]) { nodes { id } pageInfo { endCursor hasNextPage } totalCount } }`),
    { items: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false }, totalCount: 0 } });
});

test("graphqlAction is a read action with the Wiki's input and result", async () => {
  const action = graphqlAction(schema);
  assert.deepEqual([action.access, action.readOnly], ["read", true]);
  const db = await database(1);
  const identity = { userId: "u", canEdit: false } as never;
  const result = await action.invoke({ identity, actor: {} as never, originActor: {} as never, db: () => db } as never, { query: "{ items { nodes { title } } }" }, true);
  assert.deepEqual(result, { data: { items: { nodes: [{ title: "Item 0" }] } } });
});

test("startsWith is a range an index seeks, and means what the in-memory filter means", async () => {
  const db = await database(0);
  const last = "\u{10FFFF}";
  const titles = ["", "a", "ab", "a%", "a_c", "abc", "A", "b", `a${last}`, `a${last}b`, `a${last}${last}`, last, `${last}z`, "a\uD7FF", "a\uD7FFz", "a\uE000", "é", "éa"];
  await db.insert(items).values(titles.map((title, index) => ({ id: `t-${String(index).padStart(2, "0")}`, title, status: "open", receivedAt: index })));
  await db.run(sql`CREATE INDEX items_title ON items (title, id)`);
  const columns = { title: { column: sql`${items.title}`, kind: "string" as const } };
  for (const prefix of ["", "a", "ab", "a%", "a_", "A", "c", `a${last}`, `a${last}${last}`, last, `${last}${last}`, "a\uD7FF", "é"]) {
    for (const filter of [{ title: { startsWith: prefix } }, { not: { title: { startsWith: prefix } } }]) {
      const rows = await db.select({ title: items.title }).from(items).where(filterSql(filter, columns)).orderBy(items.id);
      assert.deepEqual(rows.map(row => row.title), titles.filter(title => matchesFilter({ title }, filter, { title: "string" })), JSON.stringify(filter));
    }
  }
  const plan = await db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN SELECT id FROM items WHERE ${filterSql({ title: { startsWith: "ab" } }, columns)} ORDER BY title, id LIMIT 3`);
  assert.match(plan.map(row => row.detail).join("\n"), /SEARCH items USING (COVERING )?INDEX items_title \(title>\? AND title<\?\)/);
  assert.doesNotMatch(plan.map(row => row.detail).join("\n"), /TEMP B-TREE|SCAN/);
});

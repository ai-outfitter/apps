import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { defineEntity, entityAPI, entityOperations, type EntityListQuery } from "../src/entities";
import { matchesSearch, pageCondition, searchClause, searchExpression } from "../src/entity-query";
import { within } from "../src/graph-filter-sql";
import { defineOperation, operationAPI } from "../src/operations";
import { identityHeaderValues, type AppIdentity } from "../src/server";

const who: AppIdentity = { userId: "owner", installationId: "inventory", owner: { kind: "user", id: "owner" }, role: "owner", canEdit: true };
const request = (operation: string, body?: unknown, role = "owner") => new Request(`https://app.internal/${operation}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { ...identityHeaderValues({ ...who, role }), "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("an unrelated inventory app declares records without writing a CRUD router or serializer", async () => {
  const schema = z.strictObject({ name: z.string().min(1), quantity: z.number().int().nonnegative().default(0), sku: z.string().default("default-sku").optional() });
  type Row = { id: string; revision: number; name: string; quantity: number; sku?: string; privateAudit: string };
  let row: Row = { id: "widget", revision: 1, name: "Widget", quantity: 12, sku: "stored-sku", privateAudit: "private" };
  let writes = 0;
  const inventory = defineEntity<Row, typeof schema>({
    type: "stock-item", title: "Inventory", description: "Stock in the warehouse", schema,
    name: value => value.name,
    can: () => true, // App policy cannot widen the standard editor requirement.
    list: async () => [row], get: async () => row,
    update: async (_identity, current, fields, revision) => {
      assert.equal(current.id, "widget");
      assert.equal(revision, row.revision);
      writes++;
      row = { ...row, ...fields, revision: revision + 1 };
      return row;
    },
  });
  const api = (operation: string, body?: unknown, role?: string) => entityAPI(request(operation, body, role), operation, [inventory]);
  const types = await (await api("types")).json() as { operations: string[] }[];
  assert.deepEqual(types[0].operations, ["list", "get", "update"]);
  assert.equal((await api("create", { type: "stock-item", attributes: { name: "New" } })).status, 403);
  assert.equal((await api("update", { type: "stock-item", id: "widget", revision: 1, attributes: { quantity: 6 } }, "member")).status, 403);
  const saved = await (await api("update", { type: "stock-item", id: "widget", revision: 1, attributes: { name: "Renamed" } })).json() as { attributes: Record<string, unknown>; revision: number; ref: unknown };
  assert.deepEqual(saved.attributes, { name: "Renamed", quantity: 12, sku: "stored-sku" });
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.ref, { installationId: "inventory", type: "stock-item", id: "widget" });
  assert.equal((await api("update", { type: "stock-item", id: "widget", revision: 1, attributes: { name: "Stale" } })).status, 409);
  assert.equal((await api("update", { type: "stock-item", id: "widget", revision: 2, attributes: { privateAudit: "overwrite" } })).status, 400);
  assert.equal(writes, 1);
  const direct = await entityOperations([inventory]).get.execute(request("get", { type: "stock-item", id: "widget" }), who);
  assert.deepEqual(direct, await (await api("get", { type: "stock-item", id: "widget" })).json());
});

test("apps supply their own read restrictions and unsupported operations are not advertised", async () => {
  const provider = defineEntity({
    type: "invoice", title: "Invoice", description: "Accounts payable",
    schema: z.strictObject({ amount: z.number() }), name: () => "Invoice",
    can: (identity) => identity.canEdit,
    list: async () => [],
    get: async () => ({ id: "one", revision: 1, amount: 10 }),
  });
  const denied = await entityAPI(request("get", { type: "invoice", id: "one" }, "member"), "get", [provider]);
  assert.equal(denied.status, 403);
  assert.deepEqual(await (await entityAPI(request("types", undefined, "member"), "types", [provider])).json(), []);
  const types = await (await entityAPI(request("types"), "types", [provider])).json() as { writable: boolean; operations: string[] }[];
  assert.equal(types[0].writable, false);
  assert.deepEqual(types[0].operations, ["list", "get"]);
});

test("the same dispatcher supports schema-defined domain actions outside entity CRUD", async () => {
  let reserved = 0;
  const reserve = defineOperation({
    method: "POST", input: z.strictObject({ quantity: z.number().int().positive() }), output: z.strictObject({ reserved: z.number() }),
    authorize: (identity: AppIdentity) => { if (!identity.canEdit) throw new Response("Forbidden", { status: 403 }); },
    run: (_identity, input) => { reserved += input.quantity; return { reserved }; },
  });
  const api = (name: string, req: Request, identity = who) => operationAPI(req, name, { reserve }, () => identity);
  assert.equal((await api("missing", request("missing", {}))).status, 404);
  assert.equal((await api("reserve", request("reserve"))).status, 405);
  assert.equal((await api("reserve", request("reserve", { quantity: -1 }))).status, 400);
  assert.equal((await api("reserve", request("reserve", { quantity: 2 }), { ...who, canEdit: false })).status, 403);
  assert.equal(reserved, 0);
  assert.deepEqual(await (await api("reserve", request("reserve", { quantity: 2 }))).json(), { reserved: 2 });
  assert.deepEqual(await reserve.execute(request("reserve", { quantity: 1 }), who), { reserved: 3 });
  const bad = defineOperation({ method: "POST", input: z.strictObject({}), output: z.string(), authorize: () => {}, run: () => 1 });
  assert.equal((await operationAPI(request("bad", {}), "bad", { bad }, () => who)).status, 502);
});


test("filters are advertised, validated and forwarded only to supporting providers", async () => {
  let calls = 0;
  const definition = {
    type: "item", title: "Item", description: "Fixture", schema: z.strictObject({ name: z.string() }),
    name: (row: { id: string; revision: number; name: string }) => row.name,
    get: async () => ({ id: "one", revision: 1, name: "One" }),
    list: async (_who: AppIdentity, query: EntityListQuery<Record<string, unknown>>) => {
      calls++;
      assert.deepEqual({ limit: query.limit, filter: query.filter }, { limit: 3, filter: { name: "One" } });
      return [{ id: "one", revision: 1, name: "One" }];
    },
  };
  const filtered = defineEntity({ ...definition, filterSchema: z.object({ name: z.string().min(1) }) });
  const api = (operation: string, body?: unknown, provider = filtered) => entityAPI(request(operation, body), operation, [provider]);
  const discovery = await (await api("types")).json() as { filterSchema?: unknown }[];
  assert.equal((discovery[0].filterSchema as { additionalProperties: boolean }).additionalProperties, false);
  assert.equal((await api("list", { type: "item", limit: 2, filter: { name: "One" } })).status, 200);
  for (const filter of [{ unknown: "One" }, { name: "One", unknown: "ignored" }, { name: 1 }]) {
    assert.equal((await api("list", { type: "item", filter })).status, 400);
  }
  assert.equal((await api("list", { type: "item", filter: { name: "One" } }, defineEntity(definition))).status, 400);
  assert.equal(calls, 1);
  const plain = defineEntity({ ...definition, list: async (_who, query) => {
    assert.equal(query.filter, undefined);
    return [{ id: "one", revision: 1, name: "One" }];
  } });
  assert.equal((await api("list", { type: "item" }, plain)).status, 200);
  assert.equal((await api("list", { type: "item", filter: {} }, plain)).status, 400);
  // Search needs declared searchFields; offset paging is gone.
  assert.equal((await api("list", { type: "item", search: "One" }, plain)).status, 400);
  assert.equal((await api("list", { type: "item", offset: 1 }, plain)).status, 400);
});

test("a drizzle provider reads known IDs, searches declared fields and pages by keyset in its own database", async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { sqliteTable, text, integer } = await import("drizzle-orm/sqlite-core");
  const { and } = await import("drizzle-orm");
  const client = createClient({ url: ":memory:" });
  await client.execute("CREATE TABLE parts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL, notes TEXT, created_at INTEGER NOT NULL)");
  const parts = sqliteTable("parts", { id: text("id").primaryKey(), revision: integer("revision").notNull(), name: text("name").notNull(), notes: text("notes"), createdAt: integer("created_at").notNull() });
  const db = drizzle(client);
  const rows = Array.from({ length: 25 }, (_, index) => ({ id: `p${String(index).padStart(2, "0")}`, revision: 1, name: index % 2 ? `Bracket ${index}` : `Bolt ${index}`, notes: index === 7 ? "titanium 100%" : null, createdAt: 1000 - (index % 5) }));
  await db.insert(parts).values(rows);
  await client.execute("CREATE INDEX parts_name ON parts (name, id)");
  await client.execute("CREATE INDEX parts_created ON parts (created_at, id)");
  const statements: string[] = [];
  const plans: Promise<string>[] = [];
  const counted = drizzle(client, { logger: { logQuery: (query, params) => {
    statements.push(query);
    plans.push(client.execute({ sql: `EXPLAIN QUERY PLAN ${query}`, args: params as string[] }).then(plan => plan.rows.map(row => String(row.detail)).join("; ")));
  } } });
  const provider = defineEntity({
    type: "part", title: "Part", description: "Fixture", schema: z.strictObject({ name: z.string(), notes: z.string().nullable(), createdAt: z.number() }),
    collection: "parts", orderFields: ["name", "createdAt"], searchFields: ["name", "notes"], name: row => row.name,
    get: async () => rows[0],
    list: async (_who, query) => {
      const page = pageCondition(query, { id: parts.id, order: { name: parts.name, createdAt: parts.createdAt }, search: [parts.name, parts.notes] });
      return counted.select().from(parts).where(and(page.where)).orderBy(...page.orderBy).limit(query.limit);
    },
  });
  const list = async (body: Record<string, unknown>) => {
    const response = await entityAPI(request("list", { type: "part", ...body }), "list", [provider]);
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as { records: { ref: { id: string }; attributes: Record<string, unknown> }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  };
  const types = await (await entityAPI(request("types"), "types", [provider])).json() as { searchFields: string[] }[];
  assert.deepEqual(types[0].searchFields, ["name", "notes"]);

  const known = await list({ ids: ["p03", "p20", "missing"] });
  assert.deepEqual(known.records.map(record => record.ref.id), ["p03", "p20"]);
  assert.equal(known.pageInfo.hasNextPage, false);

  // Boolean search over the declared fields; % is literal.
  assert.deepEqual((await list({ search: 'bracket NOT "1"' })).records.map(record => record.ref.id), ["p03", "p05", "p09", "p23"]);
  assert.deepEqual((await list({ search: "100%" })).records.map(record => record.ref.id), ["p07"]);

  // Every page is one bounded statement; following the cursor visits each row once, in order.
  const walk = async (order: { field: "id" | "name" | "createdAt"; direction: "asc" | "desc" }) => {
    const seen: string[] = [];
    let after: string | undefined;
    do {
      const page = await list({ order, limit: 4, ...(after ? { after } : {}) });
      seen.push(...page.records.map(record => record.ref.id));
      after = page.pageInfo.endCursor ?? undefined;
    } while (after);
    return seen;
  };
  const sorted = (key: (row: typeof rows[number]) => string | number, sign: number) =>
    [...rows].sort((a, b) => sign * (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : 1)).map(row => row.id);
  for (const [order, expected] of [
    [{ field: "createdAt", direction: "desc" }, sorted(row => row.createdAt, -1)],
    [{ field: "name", direction: "asc" }, sorted(row => row.name, 1)],
    [{ field: "id", direction: "desc" }, sorted(row => row.id, -1)],
  ] as const) {
    statements.length = 0;
    plans.length = 0;
    assert.deepEqual(await walk(order), expected);
    assert.equal(statements.length, 7);
    assert.ok(statements.every(statement => /limit \?$/i.test(statement.trim())));
    // Each page seeks the (order field, id) index from the cursor: no scan, no sort.
    const index = { createdAt: "parts_created", name: "parts_name", id: "sqlite_autoindex_parts_1" }[order.field];
    for (const plan of (await Promise.all(plans.splice(0))).slice(1)) {
      assert.match(plan, new RegExp(`^SEARCH parts USING INDEX ${index} \\(.*[<>].*\\)$`), plan);
    }
  }
  const first = await list({ order: { field: "name", direction: "asc" }, limit: 2 });
  const refused = await entityAPI(request("list", { type: "part", order: { field: "createdAt", direction: "asc" }, after: first.pageInfo.endCursor }), "list", [provider]);
  assert.equal(refused.status, 400);
});

/** A SQLite table of parts behind a drizzle provider, with every statement's bound parameters recorded. */
async function partsProvider(rows: { id: string; revision: number; name: string; notes: string | null }[]) {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { sqliteTable, text, integer } = await import("drizzle-orm/sqlite-core");
  const { and, sql } = await import("drizzle-orm");
  const client = createClient({ url: ":memory:" });
  await client.execute("CREATE TABLE parts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL, notes TEXT)");
  await client.execute("CREATE INDEX parts_name ON parts (name, id)");
  const parts = sqliteTable("parts", { id: text("id").primaryKey(), revision: integer("revision").notNull(), name: text("name").notNull(), notes: text("notes") });
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(client, { logger: { logQuery: (query, params) => { statements.push({ sql: query, params }); } } });
  for (let index = 0; index < rows.length; index += 50) await db.insert(parts).values(rows.slice(index, index + 50));
  statements.length = 0;
  const filterSchema = z.strictObject({ names: z.array(z.string()).max(100).optional() });
  const provider = defineEntity<typeof rows[number], z.ZodObject, typeof filterSchema>({
    type: "part", title: "Part", description: "Fixture", schema: z.strictObject({ name: z.string(), notes: z.string().nullable() }), filterSchema,
    collection: "parts", orderFields: ["name"], searchFields: ["name", "notes"], name: row => row.name.slice(0, 200),
    get: async () => rows[0],
    list: async (_who, query) => {
      const page = pageCondition(query, { id: parts.id, order: { name: parts.name }, search: [parts.name, parts.notes] });
      const names = query.filter?.names;
      return db.select().from(parts).where(and(page.where, names ? sql`${parts.name} IN ${within(names)}` : undefined)).orderBy(...page.orderBy).limit(query.limit);
    },
  });
  const call = (body: Record<string, unknown>) => entityAPI(request("list", { type: "part", ...body }), "list", [provider]);
  const list = async (body: Record<string, unknown>) => {
    const response = await call(body);
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as { records: { ref: { id: string }; title: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  };
  return { call, list, statements };
}

test("a page of 100 known IDs with search and a list filter binds each list once, far under D1's 100 parameters", async () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({ id: `p${String(index).padStart(3, "0")}`, revision: 1, name: `Bolt ${index}`, notes: index % 2 ? "steel" : "brass" }));
  const { call, list, statements } = await partsProvider(rows);
  const ids = rows.slice(0, 100).map(row => row.id);
  const first = await list({ ids, search: "bolt AND steel", filter: { names: rows.map(row => row.name).slice(0, 100) }, order: { field: "name", direction: "asc" }, limit: 30 });
  assert.equal(first.records.length, 30);
  const second = await list({ ids, search: "bolt AND steel", filter: { names: rows.map(row => row.name).slice(0, 100) }, order: { field: "name", direction: "asc" }, limit: 100, after: first.pageInfo.endCursor });
  assert.equal(second.records.length, 20);
  assert.equal(statements.length, 2);
  // IDs: one. Cursor: two. Search: two terms over two fields. Filter list: one. Limit: one.
  assert.deepEqual(statements.map(statement => statement.params.length), [7, 9]);
  for (const statement of statements) assert.match(statement.sql, /"id" in \(select value from json_each\(\?\)\)/i);
  // One budget covers IDs, cursor, search and filter together: 39 terms over two fields fit alone, not beside a filter.
  const terms = Array.from({ length: 39 }, (_, index) => `t${index}`).join(" OR ");
  assert.equal((await call({ search: terms })).status, 200);
  const refused = await call({ ids, search: terms, filter: { names: ["Bolt 1"] } });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /80 bound parameters/);
});

test("search folds ASCII case only, the same in SQLite and in memory", async () => {
  const names = ["Élodie", "ÉCOLE", "Škoda", "élodie", "Plain"];
  const { list } = await partsProvider(names.map((name, index) => ({ id: `n${index}`, revision: 1, name, notes: null })));
  const expected: Record<string, string[]> = {
    "Élodie": ["Élodie"], "ÉLODIE": ["Élodie"], "ÉCOLE": ["ÉCOLE"], "École": ["ÉCOLE"], "Škoda": ["Škoda"], "ŠKODA": ["Škoda"],
    "élodie": ["élodie"], "škoda": [], "lodie": ["Élodie", "élodie"], "PLAIN": ["Plain"],
  };
  for (const [search, found] of Object.entries(expected)) {
    assert.deepEqual((await list({ search })).records.map(record => record.title).sort(), [...found].sort(), `SQL: ${search}`);
    assert.deepEqual(names.filter(name => matchesSearch(searchExpression(search), name)).sort(), [...found].sort(), `memory: ${search}`);
  }
  const clause = searchClause(searchExpression("Élodie"), ["name"]);
  assert.equal(clause.sql, "(instr(lower(coalesce(name, '')), lower(?)) > 0)");
  assert.deepEqual(clause.params, ["Élodie"]);
});

test("a cursor over a 160-character CJK order value stays within the after limit and round-trips", async () => {
  const title = (lead: string) => lead + "漢".repeat(159);
  const rows = ["一", "二", "三"].map((lead, index) => ({ id: `c${index}`, revision: 1, name: title(lead), notes: null }));
  const { list, call } = await partsProvider(rows);
  const order = { field: "name", direction: "asc" };
  const first = await list({ order, limit: 1 });
  const cursor = first.pageInfo.endCursor as string;
  assert.ok(cursor.length <= 2048 && cursor.length < 800, String(cursor.length));
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")), { f: "name", d: "asc", v: first.records[0].title, i: first.records[0].ref.id });
  const seen = [first.records[0].ref.id];
  for (let after: string | null = cursor; after;) {
    const page = await list({ order, limit: 1, after });
    seen.push(...page.records.map(record => record.ref.id));
    after = page.pageInfo.endCursor;
  }
  assert.deepEqual(seen, [...rows].sort((a, b) => (a.name < b.name ? -1 : 1)).map(row => row.id));
  assert.equal((await call({ order, after: "x".repeat(2048) })).status, 400);
  assert.equal((await call({ order, after: "%%%" })).status, 400);
});

test("a malformed quoted phrase is refused, never a server error", async () => {
  const { call, list } = await partsProvider([{ id: "a", revision: 1, name: "say \"hello\" in C:\\Users", notes: null }]);
  for (const search of ['"hello', '"C:\\Users"', '"tab\there"', '"', 'a "b', '"bad \\u12"']) {
    assert.throws(() => searchExpression(search), (error: unknown) => error instanceof Response && error.status === 400, search);
    const response = await call({ search });
    assert.equal(response.status, 400, search);
    assert.match(await response.text(), /quoted phrase/);
  }
  assert.equal((await list({ search: '"C:\\\\Users"' })).records.length, 1);
  assert.equal((await list({ search: '"\\"hello\\" in"' })).records.length, 1);
});

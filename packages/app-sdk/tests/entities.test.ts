import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { defineEntity, entityAPI, entityOperations, type EntityListQuery } from "../src/entities";
import { pageCondition } from "../src/entity-query";
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
  const statements: string[] = [];
  const counted = drizzle(client, { logger: { logQuery: query => statements.push(query) } });
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
    assert.deepEqual(await walk(order), expected);
    assert.equal(statements.length, 7);
    assert.ok(statements.every(statement => /limit \?$/i.test(statement.trim())));
  }
  const first = await list({ order: { field: "name", direction: "asc" }, limit: 2 });
  const refused = await entityAPI(request("list", { type: "part", order: { field: "createdAt", direction: "asc" }, after: first.pageInfo.endCursor }), "list", [provider]);
  assert.equal(refused.status, 400);
});

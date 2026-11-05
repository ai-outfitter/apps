import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { defineEntity, entityAPI, entityOperations } from "../src/entities";
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
    list: async (_who: AppIdentity, offset: number, limit: number, filter?: Record<string, unknown>) => {
      calls++;
      assert.deepEqual({ offset, limit, filter }, { offset: 1, limit: 2, filter: { name: "One" } });
      return [{ id: "one", revision: 1, name: "One" }];
    },
  };
  const filtered = defineEntity({ ...definition, filterSchema: z.object({ name: z.string().min(1) }) });
  const api = (operation: string, body?: unknown, provider = filtered) => entityAPI(request(operation, body), operation, [provider]);
  const discovery = await (await api("types")).json() as { filterSchema?: unknown }[];
  assert.equal((discovery[0].filterSchema as { additionalProperties: boolean }).additionalProperties, false);
  assert.equal((await api("list", { type: "item", offset: 1, limit: 2, filter: { name: "One" } })).status, 200);
  for (const filter of [{ unknown: "One" }, { name: "One", unknown: "ignored" }, { name: 1 }]) {
    assert.equal((await api("list", { type: "item", filter })).status, 400);
  }
  assert.equal((await api("list", { type: "item", filter: { name: "One" } }, defineEntity(definition))).status, 400);
  assert.equal(calls, 1);
  const plain = defineEntity({ ...definition, list: async (_who, _offset, _limit, filter) => {
    assert.equal(filter, undefined);
    return [{ id: "one", revision: 1, name: "One" }];
  } });
  assert.equal((await api("list", { type: "item" }, plain)).status, 200);
  assert.equal((await api("list", { type: "item", filter: {} }, plain)).status, 400);
});

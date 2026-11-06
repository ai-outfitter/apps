import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { actionAPI, actionOperations, actionToolDescriptor, publishActionTools, defineAction, type ActionContext } from "../src/actions";
import { encodeActor, identityHeaderValues, identityHeaders, requestActor, requestOriginActor, type AppIdentity } from "../src/server";

const who: AppIdentity = { userId: "owner", organizationId: "org", installationId: "kitchen", owner: { kind: "organization", id: "org" }, role: "owner", canEdit: true };
const request = (operation: string, body?: unknown, role = "owner", actor?: string) => new Request(`https://app.internal/${operation}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { ...identityHeaderValues({ ...who, role }), "content-type": "application/json", ...(actor ? { [identityHeaders.actor]: actor } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

// A synthetic catering app: its business logic stays in its own handlers.
type Context = ActionContext & { orders: { dish: string; by: string }[] };
const orders: Context["orders"] = [];
const actions = {
  "menu.read": defineAction({
    description: "Dishes available today", access: "read",
    mcpTool: "kitchen_menu_read",
    input: z.strictObject({}), output: z.strictObject({ dishes: z.array(z.string()) }),
    run: () => ({ dishes: ["soup"] }),
  }),
  "order.place": defineAction({
    description: "Order one dish", access: "write",
    input: z.strictObject({ dish: z.enum(["soup"]) }), output: z.strictObject({ count: z.number(), by: z.string() }),
    run: (context: Context, input) => {
      if (context.orders.length > 1) throw new Response("Sold out", { status: 409 });
      context.orders.push({ dish: input.dish, by: `${context.actor.kind}:${context.actor.id}` });
      return { count: context.orders.length, by: `${context.actor.kind}:${context.actor.id}` };
    },
  }),
};
const api = (operation: string, body?: unknown, role?: string, actor?: string) =>
  actionAPI(request(operation, body, role, actor), operation, actions, () => ({ orders }));

test("action request limits default to 256 KiB and can be bounded per app", async () => {
  const payload = { "file.write": defineAction({ description: "Store file", access: "write", input: z.object({ data: z.string() }), output: z.number(), run: (_context: ActionContext, input) => input.data.length }) };
  const body = { action: "file.write", input: { data: "x".repeat(300_000) } };
  assert.equal((await actionAPI(request("call", body), "call", payload, () => ({}))).status, 413);
  const accepted = await actionAPI(request("call", body), "call", payload, () => ({}), { maxCallBytes: 400_000 });
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.json(), 300_000);
  assert.equal((await actionAPI(request("call", body, "member"), "call", payload, () => ({}), { maxCallBytes: 400_000 })).status, 403);
  assert.equal((await actionAPI(request("call", { action: "file.write", input: { data: "x".repeat(400_000) } }), "call", payload, () => ({}), { maxCallBytes: 400_000 })).status, 413);
  assert.throws(() => actionOperations(payload, { maxCallBytes: 4_010_001 }), /size limit/);
});

test("a sidebar agent's tools have one validated name and schema", () => {
  const published = publishActionTools("kitchen", actions);
  const tool = actionToolDescriptor(published["menu.read"]);
  assert.equal(tool.name, published["menu.read"].mcpTool);
  assert.deepEqual(tool.inputSchema, published["menu.read"].input);
  assert.equal(tool.store, false);
  assert.equal(published["order.place"].mcpTool, "kitchen_order_place");
  assert.throws(() => actionToolDescriptor(actions["order.place"]), /must be named/);
  assert.throws(() => publishActionTools("kitchen", { "menu.read": actions["menu.read"], "another.read": actions["menu.read"] }), /Conflicting/);
  assert.throws(() => publishActionTools("other", actions), /Conflicting/);
  assert.throws(() => publishActionTools("outfitter", { "order.place": actions["order.place"] }));
});

test("apps publish discoverable actions with permissions derived from the verified identity", async () => {
  const listed = await (await api("list", undefined, "member")).json() as { name: string; description: string; access: string; permitted: boolean; mcpTool?: string; input: { properties: object } }[];
  // A catalog names no tools: a sidebar agent names its own.
  assert.deepEqual(listed.map((a) => [a.name, a.access, a.permitted]), [["menu.read", "read", true], ["order.place", "write", false]]);
  assert.equal(listed[1].description, "Order one dish");
  assert.ok(listed[1].input.properties);
  assert.deepEqual(listed.map((a) => a.mcpTool), [undefined, undefined]);
  assert.throws(() => defineAction({ description: "reserved", access: "read", input: z.strictObject({}), output: z.json(), mcpTool: "outfitter_whoami", run: () => null }));
  assert.equal((await api("call", { action: "order.place", input: { dish: "soup" } }, "member")).status, 403);
  assert.equal((await api("call", { action: "order.missing", input: {} })).status, 404);
  assert.equal((await api("call", { action: "order.place", input: { dish: "cake" } })).status, 400);
  assert.equal((await api("list", {})).status, 405);
  assert.equal(orders.length, 0);
});

test("the actor is the platform-forwarded caller, never a request body field", async () => {
  const client = encodeActor({ kind: "oauth-client", id: "client-1", label: "Claude Code" });
  assert.deepEqual(await (await api("call", { action: "order.place", input: { dish: "soup" } }, "owner", client)).json(), { count: 1, by: "oauth-client:client-1" });
  assert.deepEqual(await (await api("call", { action: "order.place", input: { dish: "soup" } })).json(), { count: 2, by: "member:owner" });
  // Strict schemas reject smuggled provenance; the handler's own policy still applies.
  assert.equal((await api("call", { action: "order.place", input: { dish: "soup", actor: "admin" } })).status, 400);
  assert.equal((await api("call", { action: "order.place", input: { dish: "soup" } })).status, 409);
  for (const forged of ["not-json", encodeURIComponent(JSON.stringify({ kind: "root", id: "x" })), encodeURIComponent(JSON.stringify({ kind: "member" }))])
    assert.equal((await api("call", { action: "menu.read", input: {} }, "owner", forged)).status, 401);
  assert.deepEqual(requestActor(request("list"), who), { kind: "member", id: "owner" });
});

test("trusted in-process adapters run the same validation and policy", async () => {
  const operations = actionOperations(actions);
  const app = { kind: "app" as const, id: "planning" };
  const context = { identity: { ...who, canEdit: false, role: "member" }, actor: app, originActor: app, orders: [] };
  await assert.rejects(operations.call.execute(request("call", { action: "order.place", input: { dish: "soup" } }), context),
    (error: unknown) => error instanceof Response && error.status === 403);
  assert.deepEqual(await operations.call.execute(request("call", { action: "menu.read", input: {} }), context), { dishes: ["soup"] });
  assert.throws(() => actionOperations({ Bad: actions["menu.read"] }));
  const broken = defineAction({ description: "x", access: "read", input: z.strictObject({}), output: z.string(), run: () => 1 });
  await assert.rejects(broken.invoke(context, {}), (error: unknown) => error instanceof Response && error.status === 502);
});

test("origin attribution uses only trusted headers and malformed origins fail closed", () => {
  const original = { kind: "oauth-client" as const, id: "original" };
  const forwarded = request("call", {}, "owner", encodeActor({ kind: "app", id: "planning" }));
  forwarded.headers.set(identityHeaders.originActor, encodeActor(original));
  assert.deepEqual(requestActor(forwarded, who), { kind: "app", id: "planning" });
  assert.deepEqual(requestOriginActor(forwarded, who), original);
  // Without an origin header the immediate caller started the chain.
  assert.deepEqual(requestOriginActor(request("list"), who), { kind: "member", id: "owner" });
  forwarded.headers.set(identityHeaders.originActor, "malformed");
  assert.throws(() => requestOriginActor(forwarded, who), (error: unknown) => error instanceof Response && error.status === 401);
});

test("an explicit app policy authorizes member writes and is rechecked at invocation", async () => {
  let assigned = true;
  const action = defineAction({
    description: "Synthetic role duty", access: "write",
    input: z.strictObject({}), output: z.strictObject({ saved: z.boolean() }),
    canInvoke: (context: ActionContext) => context.identity.organizationId === "org" && assigned,
    run: () => ({ saved: true }),
  });
  const identity = { ...who, role: "member", canEdit: false };
  const context: ActionContext = { identity, actor: { kind: "member", id: "holder" }, originActor: { kind: "member", id: "holder" } };
  assert.equal(action.permitted(context), true);
  assert.deepEqual(await action.invoke(context, {}), { saved: true });
  assigned = false;
  await assert.rejects(action.invoke(context, {}), (error: unknown) => error instanceof Response && error.status === 403);
  assert.equal(action.permitted(context), false);
});

test("a read-only call runs only a read action or a declared side-effect-free variant, judged as it runs", async () => {
  const effects: string[] = [];
  const readable = {
    "menu.read": defineAction({ description: "Dishes", access: "read", input: z.strictObject({}), output: z.json(), run: () => ({ dishes: ["soup"] }) }),
    "queue.list": defineAction({
      description: "Lists the queue and starts due orders", access: "write", input: z.strictObject({}), output: z.json(), canInvoke: () => true,
      run: () => { effects.push("started"); return { queue: ["started"] }; },
      read: () => ({ queue: ["due"] }),
    }),
    "order.place": defineAction({ description: "Order", access: "write", input: z.strictObject({}), output: z.json(), canInvoke: () => true,
      run: () => { effects.push("ordered"); return { ok: true }; } }),
  };
  const call = (body: unknown) => actionAPI(request("call", body), "call", readable, () => ({}));
  const listed = await (await actionAPI(request("list"), "list", readable, () => ({}))).json() as { name: string; readOnly: boolean }[];
  assert.deepEqual(listed.map((a) => [a.name, a.readOnly]), [["menu.read", true], ["queue.list", true], ["order.place", false]]);
  assert.deepEqual(await (await call({ action: "menu.read", input: {}, access: "read" })).json(), { dishes: ["soup"] });
  assert.deepEqual(await (await call({ action: "queue.list", input: {}, access: "read" })).json(), { queue: ["due"] });
  assert.equal((await call({ action: "order.place", input: {}, access: "read" })).status, 403);
  assert.equal((await call({ action: "order.place", input: {}, access: "write" })).status, 400, "only `read` may be asked for");
  assert.deepEqual(effects, []);
  // Ordinary calls are unchanged.
  assert.deepEqual(await (await call({ action: "queue.list", input: {} })).json(), { queue: ["started"] });
  assert.deepEqual(await (await call({ action: "order.place", input: {} })).json(), { ok: true });
  assert.deepEqual(effects, ["started", "ordered"]);
});

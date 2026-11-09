import assert from "node:assert/strict";
import test from "node:test";
import { appDataContext } from "../src/database";
import { workflowHost, type WorkflowHost } from "../src/workflow-host";

test("collections resolve scoped discovery and route bounded queries through entity host", async () => {
  const calls: { operation: string; input: unknown }[] = [];
  const host = { call: async (operation: string, input: unknown) => {
    calls.push({ operation, input });
    if (operation === "entities.types") return [{ template: "wiki-map", installationId: "wiki-1", type: "graph-node", collection: "nodes" }];
    const record = { ref: { installationId: "wiki-1", type: "graph-node", id: "one" }, revision: 3, title: "Product", attributes: { summary: "Summary" }, references: [] };
    return operation === "entities.get" ? record : [record];
  } } as unknown as WorkflowHost<"interactive">;
  const context = appDataContext(host);
  const wiki = await context.apps.database("wiki-map");
  assert.deepEqual(calls[0], { operation: "entities.types", input: { template: "wiki-map" } });
  assert.equal(wiki.installationId, "wiki-1");
  assert.equal(wiki.hostname, null);
  const rows = await wiki.collection("nodes").list({ where: { typeId: "product" }, select: ["id", "summary"], limit: 5 });
  assert.deepEqual(calls[1], { operation: "entities.list", input: { installationId: "wiki-1", type: "graph-node", filter: { typeId: "product" }, select: ["id", "summary"], offset: 0, limit: 5 } });
  assert.equal(rows[0].id, "one");
  assert.equal(rows[0].ref.installationId, "wiki-1");
  assert.equal(rows[0].revision, 3);
  const retrieved = await wiki.collection("nodes").get("one");
  assert.equal(retrieved.ref.id, "one");
  assert.equal(retrieved.attributes.summary, "Summary");
  await context.apps.database("wiki-map");
  assert.equal(calls.filter(call => call.operation === "entities.types").length, 1);
  assert.equal((await (await context.apps.installation("wiki-1")).collection("nodes").get("one")).id, "one");
  await assert.rejects(context.apps.installation("foreign"));
  await assert.rejects(context.apps.database("other"));
  // A template path rather than its slug is refused before the host is asked.
  const before = calls.length;
  await assert.rejects(context.apps.database("outfitter/wiki-map"), (error: unknown) => error instanceof Response && error.status === 400);
  assert.equal(calls.length, before);
});

test("a non-engineering provider filters and orders before pagination", async () => {
  const { createClient } = await import("@libsql/client");
  const { z } = await import("zod");
  const { defineEntity, entityOperations, entityRecord } = await import("../src/entities");
  const db = createClient({ url: "file::memory:" });
  await db.execute("create table staff (id text, revision integer, name text, department text)");
  for (const [id, name, department] of [["a", "Ada", "IT"], ["b", "Bea", "HR"], ["c", "Cleo", "HR"]])
    await db.execute({ sql: "insert into staff values (?, 1, ?, ?)", args: [id, name, department] });
  let executed = 0;
  const schema = z.strictObject({ name: z.string(), department: z.string() });
  const provider = defineEntity({
    type: "staff", collection: "people", title: "Staff", description: "People", schema,
    filterSchema: z.strictObject({ department: z.string().optional() }), orderFields: ["name"], selectFields: ["id", "name"],
    name: row => row.name,
    list: async (_who, offset, limit, filter, order) => {
      executed++;
      const rows = await db.execute({ sql: `select * from staff where department = ? order by name ${order?.direction === "desc" ? "desc" : "asc"} limit ? offset ?`, args: [String(filter?.department ?? "HR"), limit, offset] });
      return rows.rows.map(row => ({ id: String(row.id), revision: Number(row.revision), name: String(row.name), department: String(row.department) }));
    },
    get: async () => ({ id: "a", revision: 1, name: "Ada", department: "IT" }),
  });
  const operations = entityOperations([provider]);
  const who = { userId: "owner", installationId: "hr", owner: { kind: "user" as const, id: "owner" }, role: "owner", canEdit: true };
  const invoke = (body: object) => operations.list.execute(new Request("https://app/list", { method: "POST", body: JSON.stringify(body) }), who);
  const rows = z.array(entityRecord).parse(await invoke({ type: "staff", filter: { department: "HR" }, order: { field: "name", direction: "desc" }, select: ["name"], limit: 1 }));
  assert.equal(rows[0].ref.id, "c");
  assert.deepEqual(rows[0].attributes, { name: "Cleo" });
  await assert.rejects(invoke({ type: "staff", filter: { owner: "other" } }));
  await assert.rejects(invoke({ type: "staff", order: { field: "department", direction: "desc" } }));
  assert.equal(executed, 1);
  db.close();
});

test("explicit installation discovery is scoped, coalesced, retryable and request-local", async () => {
  let attempts = 0;
  let fail = true;
  const call = async (operation: string, input: unknown) => {
    assert.equal(operation, "entities.types");
    assert.deepEqual(input, { installationId: "wiki" });
    attempts++;
    if (fail) throw new Response("Unavailable", { status: 503 });
    return [{ installationId: "wiki", type: "graph-node", collection: "nodes" }];
  };
  const host = { call } as unknown as WorkflowHost<"interactive">;
  await assert.rejects(appDataContext(host).apps.installation("wiki"));
  fail = false;
  await Promise.all([appDataContext(host).apps.installation("wiki"), appDataContext(host).apps.installation("wiki")]);
  assert.equal(attempts, 2);
  await appDataContext({ call } as unknown as WorkflowHost<"interactive">).apps.installation("wiki");
  assert.equal(attempts, 3, "another dispatch rechecks discovery");
});

test("template discovery does not wait for an unrelated in-flight catalog", async () => {
  let release!: () => void;
  const unrelated = new Promise<void>(resolve => { release = resolve; });
  const inputs: unknown[] = [];
  const host = { async call(_operation: string, input: { template?: string }) {
    inputs.push(input);
    if (input.template === "slow-app") await unrelated;
    return [{ installationId: input.template, template: input.template, type: "record", collection: "records" }];
  } } as unknown as WorkflowHost<"interactive">;
  const context = appDataContext(host);
  const pending = context.apps.database("slow-app");
  try {
    const wiki = await context.apps.database("wiki-map");
    assert.equal(wiki.installationId, "wiki-map");
    assert.deepEqual(inputs, [{ template: "slow-app" }, { template: "wiki-map" }]);
  } finally { release(); await pending; }
});

test("an absent provider in broad discovery does not suppress a targeted retry", async () => {
  const inputs: unknown[] = [];
  const host = { async call(_operation: string, input: { installationId?: string }) {
    inputs.push(input);
    return [{ installationId: input.installationId ?? "other", template: "custom", type: "record", collection: "records" }];
  } } as unknown as WorkflowHost<"interactive">;
  const context = appDataContext(host);
  await context.apps.database("custom");
  assert.equal((await context.apps.installation("wiki")).installationId, "wiki");
  assert.deepEqual(inputs, [{ template: "custom" }, { installationId: "wiki" }]);
});

test("failed broad discovery allows a scoped read through the validated host contract", async () => {
  const inputs: unknown[] = [];
  const host = workflowHost<"interactive">({ props: { workflowHost: {
    async call(operation: string, input: unknown) {
      assert.equal(operation, "entities.types");
      inputs.push(input);
      if (!(input as { installationId?: string }).installationId)
        return { ok: false, status: 503, message: "Unrelated provider unavailable" };
      return { ok: true, value: [{ installationId: "wiki", template: "wiki-map", hostname: "wiki.example", type: "graph-node", collection: "nodes", title: "Nodes", description: "Synthetic", schema: {}, writable: false }] };
    },
  } } });
  const context = appDataContext(host);
  const broad = context.apps.database("wiki-map");
  const scoped = context.apps.installation("wiki");
  await assert.rejects(broad, (error: unknown) => error instanceof Response && error.status === 503);
  const wiki = await scoped;
  assert.equal(wiki.installationId, "wiki");
  assert.equal(wiki.hostname, "wiki.example");
  assert.ok(wiki.collection("nodes"), "host validation preserves collection metadata");
  assert.deepEqual(inputs, [{ template: "wiki-map" }, { installationId: "wiki" }]);
});

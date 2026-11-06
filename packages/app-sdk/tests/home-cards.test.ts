import assert from "node:assert/strict";
import test from "node:test";
import {
  defineHomeCard, homeCardAPI, homeCardBody, homeCardLimits, homeCardOperations, homeCardReadResult, safeHomeCardPath,
  type HomeCardNode, type HomeCardProvider,
} from "../src/home-cards";
import { identityHeaderValues, type AppIdentity } from "../src/server";

const member: AppIdentity = { userId: "member", organizationId: "org", owner: { kind: "organization", id: "org" }, installationId: "tasks", role: "member", canEdit: false };
const request = (operation: string, body?: unknown, who: Partial<AppIdentity> = {}) => new Request(`https://app.internal/api/internal/home-cards/v1/${operation}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { ...identityHeaderValues({ ...member, ...who }), "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

// A synthetic task list: members complete only their own tasks, by revision.
function tasks() {
  const rows = new Map([["t1", { owner: "member", done: false, revision: 3 }], ["t2", { owner: "someone-else", done: false, revision: 1 }]]);
  const card = defineHomeCard({
    cardId: "my-tasks", title: "My tasks", sizes: ["small", "medium"], defaultSize: "small",
    read: async ({ identity, size }) => ({
      body: [{ kind: "list", items: [...rows].filter(([, row]) => row.owner === identity.userId).map(([id, row]) => ({
        id, title: `Task ${id}`, link: { path: `/tasks/${id}` },
        children: size === "small" ? [] : [{ kind: "action", actionId: "complete", label: "Done", input: { taskId: id }, revision: row.revision }],
      })) }],
    }),
    actions: {
      complete: async ({ identity, input, revision }) => {
        const id = (input as { taskId: string }).taskId;
        const row = rows.get(id);
        if (!row || row.owner !== identity.userId) throw new Response("Not your task", { status: 403 });
        if (row.done) return { outcome: "unchanged" };
        if (row.revision !== revision) return { outcome: "conflict", message: "Task changed" };
        Object.assign(row, { done: true, revision: row.revision + 1 });
        return { outcome: "applied" };
      },
    },
  });
  return { rows, card };
}

test("catalog, read and action route through the reserved operations with the viewer identity", async () => {
  const { rows, card } = tasks();
  const api = (operation: string, body?: unknown, who?: Partial<AppIdentity>) => homeCardAPI(request(operation, body, who), operation, [card]);
  assert.deepEqual(await (await api("catalog")).json(), {
    version: 1, cards: [{ cardId: "my-tasks", title: "My tasks", sizes: ["small", "medium"], defaultSize: "small", actionIds: ["complete"] }],
  });
  const read = await (await api("read", { cardId: "my-tasks", size: "medium" })).json();
  assert.equal(homeCardReadResult.parse(read).status, "ready");
  assert.equal(JSON.stringify(read).includes("t2"), false);
  const fallback = homeCardReadResult.parse(await (await api("read", { cardId: "my-tasks", size: "large" })).json());
  assert.equal(fallback.size, "small");
  assert.equal((await api("read", { cardId: "missing", size: "small" })).status, 404);
  assert.equal((await api("read", { cardId: "my-tasks" })).status, 400);

  // A non-editor member completes their own task; no editor gate applies.
  assert.deepEqual(await (await api("action", { cardId: "my-tasks", actionId: "complete", input: { taskId: "t1" }, revision: 3 })).json(), { version: 1, outcome: "applied" });
  assert.equal(rows.get("t1")?.done, true);
  // Repeating an already-complete task is a safe no-op.
  assert.deepEqual(await (await api("action", { cardId: "my-tasks", actionId: "complete", input: { taskId: "t1" }, revision: 3 })).json(), { version: 1, outcome: "unchanged" });
  // The provider still authorizes the record: another member's task is refused.
  assert.equal((await api("action", { cardId: "my-tasks", actionId: "complete", input: { taskId: "t2" }, revision: 1 })).status, 403);
  assert.equal(rows.get("t2")?.done, false);
  assert.equal((await api("action", { cardId: "my-tasks", actionId: "delete", input: {} })).status, 404);
  assert.equal((await api("action", { cardId: "my-tasks", actionId: "complete", input: { taskId: "x".repeat(homeCardLimits.actionInputBytes) } })).status, 400);
  assert.equal((await api("read", { cardId: "my-tasks", size: "small" }, { role: "" })).status, 401);
  assert.equal((await api("missing")).status, 404);
  assert.equal((await homeCardAPI(request("read"), "read", [card])).status, 405);
});

test("unknown node kinds, unsafe links, undeclared actions and oversized bodies are rejected", async () => {
  const body = (nodes: unknown) => () => homeCardBody.parse(nodes);
  assert.throws(body([{ kind: "html", html: "<script>alert(1)</script>" }]));
  assert.throws(body([{ kind: "text", text: "hi", onClick: "x" }]));
  assert.throws(body([{ kind: "link", label: "Out", target: { url: "https://evil.example" } }]));
  assert.throws(body([{ kind: "progress", label: "Over", value: 3, max: 2 }]));
  assert.throws(body(Array.from({ length: homeCardLimits.bodyNodes + 1 }, () => ({ kind: "text", text: "x" }))));
  assert.throws(body([{ kind: "text", text: "x".repeat(homeCardLimits.text + 1) }]));
  assert.throws(body([{ kind: "list", items: Array.from({ length: homeCardLimits.listItems + 1 }, (_, i) => ({ id: `i${i}`, title: "x" })) }]));
  // Lists cannot nest deeper than the depth cap.
  let nested: HomeCardNode = { kind: "text", text: "leaf" };
  for (let level = 0; level < homeCardLimits.depth; level++) nested = { kind: "list", items: [{ id: "i", title: "x", children: [nested] }] };
  assert.throws(body([nested]));
  // Total nodes across levels are capped as well as each level.
  const wide = { kind: "list", items: Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, title: "x", children: Array.from({ length: 6 }, () => ({ kind: "text", text: "x" })) })) };
  assert.throws(body([wide]));
  assert.doesNotThrow(body([{ kind: "link", label: "Wiki", target: { installationId: "wiki", path: "/pages/a?b=1#c" } }, { kind: "empty", text: "None" }]));

  for (const path of ["https://evil.example", "//evil.example", "/a/../b", "/%2e%2e/admin", "/%252e%252e/x", "/a\\b", "/a b", "javascript:alert(1)", "", "relative"])
    assert.equal(safeHomeCardPath(path), false, path);
  for (const path of ["/", "/tasks/t1", "/search?q=a%20b#top"]) assert.equal(safeHomeCardPath(path), true, path);

  const card = (read: HomeCardProvider["read"]) => homeCardOperations([defineHomeCard({ cardId: "card", title: "Card", sizes: ["small"], defaultSize: "small", read })]);
  const run = (read: HomeCardProvider["read"]) => card(read).read.execute(request("read", { cardId: "card", size: "small" }), member).then(() => 200, (error: Response) => error.status);
  assert.equal(await run(async () => ({ body: [{ kind: "action", actionId: "undeclared", label: "Go" }] })), 502);
  assert.equal(await run(async () => ({ body: [{ kind: "iframe" } as unknown as HomeCardNode] })), 502);
  // Within every item and node cap, multibyte text can still exceed the byte budget.
  const huge = { kind: "list", items: Array.from({ length: homeCardLimits.listItems }, (_, i) => ({ id: `i${i}`, title: "x", subtitle: "€".repeat(homeCardLimits.text) })) } as HomeCardNode;
  assert.doesNotThrow(() => homeCardBody.parse(Array.from({ length: homeCardLimits.bodyNodes }, () => huge)));
  assert.equal(await run(async () => ({ body: Array.from({ length: homeCardLimits.bodyNodes }, () => huge) })), 502);
});

test("unavailable is a typed answer distinct from an HTTP failure, and declarations are checked up front", async () => {
  const ops = homeCardOperations([defineHomeCard({ cardId: "card", title: "Card", sizes: ["small"], defaultSize: "small", read: async () => ({ unavailable: "setup-required", message: "Choose a project in the app" }) })]);
  assert.deepEqual(await ops.read.execute(request("read", { cardId: "card", size: "small" }), member),
    { version: 1, status: "unavailable", cardId: "card", size: "small", title: "Card", sizes: ["small"], defaultSize: "small", actionIds: [], reason: "setup-required", message: "Choose a project in the app" });
  const declare = (card: Partial<HomeCardProvider>) => () => defineHomeCard({ cardId: "card", title: "Card", sizes: ["small"], defaultSize: "small", read: async () => ({ body: [] }), ...card });
  assert.throws(declare({ defaultSize: "large" }));
  assert.throws(declare({ cardId: "Not A Key" }));
  assert.throws(declare({ sizes: ["small", "small"] }));
  const hidden = homeCardOperations([defineHomeCard({ cardId: "admin", title: "Admin", sizes: ["small"], defaultSize: "small", can: (who) => who.canEdit, read: async () => ({ body: [] }) })]);
  assert.deepEqual(await hidden.catalog.execute(request("catalog"), member), { version: 1, cards: [] });
  await assert.rejects(hidden.read.execute(request("read", { cardId: "admin", size: "small" }), member), (error: Response) => error.status === 403);
  assert.throws(() => homeCardOperations([declare({})(), declare({})()]));
});

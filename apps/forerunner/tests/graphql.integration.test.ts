import assert from "node:assert/strict";
import test from "node:test";
import { actionPath } from "@ai-outfitter/app-sdk/actions";
import { documentText, type ResultOf } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { graphql } from "../graph/graphql";

// The built operational worker serves each member's own board and discovery records
// over graph.graphql, the call the platform's appGraphql makes.
const alice = { userId: "alice", organizationId: "org", role: "member" };
const bob = { ...alice, userId: "bob" };
const artifact = () => appArtifact(new URL("..", import.meta.url), "operational");
const board = graphql(`
  query Board($status: [String!], $after: String) {
    items(first: 2, status: $status, after: $after) {
      nodes { id title category status updatedAt }
      pageInfo { endCursor hasNextPage }
      aggregate { count }
    }
    discoveryRecords(kind: ["run"]) { nodes { id kind createdAt } aggregate { count } }
  }
`);
type Board = ResultOf<typeof board>;
const created = Date.UTC(2026, 10, 2, 9);

async function worker(installation: string) {
  const app = await appWorker("forerunner", artifact(), installation);
  const insert = (table: string, row: Record<string, unknown>) =>
    app.database.prepare(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`)
      .bind(...Object.values(row)).run();
  const item = (ownerId: string, n: number, status: string) => insert("forerunner_items", {
    id: `${ownerId}-${String(n).padStart(3, "0")}`, installationId: app.installationId, ownerId, category: n % 2 ? "sand" : "stone",
    title: `Item ${n}`, status, position: n, createdAt: created, updatedAt: created + n,
  });
  const call = (member: typeof alice, query: string, variables: Record<string, unknown> = {}) =>
    app.call(`${actionPath}/call`, member, { method: "POST", body: { action: "graph.graphql", input: { query, variables }, access: "read" } });
  return { app, insert, item, call };
}

test("members read only their own items and discovery records, filtered and paged, never the raw data", async () => {
  const { app, insert, item, call } = await worker("graphql-filtered");
  try {
    for (const [n, status] of ["todo", "done", "todo", "todo"].entries()) await item("alice", n, status);
    await item("bob", 9, "todo");
    for (const [id, ownerId, kind] of [["d-1", "alice", "run"], ["d-2", "alice", "sample"], ["d-3", "bob", "run"]])
      await insert("forerunner_discovery_records", { id, installationId: app.installationId, ownerId, kind, data: '{"secret":"sample body"}', createdAt: created });

    const first = await call(alice, documentText(board), { status: ["todo"] });
    assert.equal(first.status, 200, await first.clone().text());
    const { items, discoveryRecords } = ((await first.json()) as { data: Board }).data;
    assert.deepEqual(items.nodes.map((node) => [node.id, node.status, node.category]), [["alice-000", "todo", "stone"], ["alice-002", "todo", "stone"]]);
    assert.equal(items.nodes[1].updatedAt, new Date(created + 2).toISOString());
    assert.deepEqual([items.pageInfo.hasNextPage, items.aggregate.count], [true, 3]);
    assert.deepEqual(discoveryRecords, { nodes: [{ id: "d-1", kind: "run", createdAt: new Date(created).toISOString() }], aggregate: { count: 1 } });
    const next = ((await (await call(alice, documentText(board), { status: ["todo"], after: items.pageInfo.endCursor })).json()) as { data: Board }).data.items;
    assert.deepEqual([next.nodes.map((node) => node.id), next.pageInfo.hasNextPage], [["alice-003"], false]);

    // Another member names Alice's IDs and continues from her cursor, and still sees only their own rows and counts.
    const theirs = await call(bob, `query($after: String) { items(ids: ["alice-003", "bob-009"], after: $after) { nodes { id } aggregate { count } } discoveryRecords(ids: ["d-1", "d-3"]) { nodes { id } aggregate { count } } }`, { after: items.pageInfo.endCursor });
    assert.deepEqual(((await theirs.json()) as { data: unknown }).data, {
      items: { nodes: [{ id: "bob-009" }], aggregate: { count: 1 } },
      discoveryRecords: { nodes: [{ id: "d-3" }], aggregate: { count: 1 } },
    });
    // The raw discovery data and the owner columns are not in the schema.
    const hidden = (await (await call(alice, "{ discoveryRecords { nodes { data ownerId } } }")).json()) as { errors?: { extensions?: { code?: string } }[] };
    assert.equal(hidden.errors?.[0]?.extensions?.code, "GRAPHQL_VALIDATION_FAILED");
    // Only platform dispatch, with a member's identity, reaches it.
    assert.equal((await app.call(`${actionPath}/call`, undefined, { method: "POST", body: { action: "graph.graphql", input: { query: "{ __typename }" } } })).status, 401);
  } finally {
    await app.dispose();
  }
});

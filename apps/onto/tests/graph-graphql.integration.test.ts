import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { graphGraphqlResult } from "@ai-outfitter/app-sdk/graph-graphql";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const member = { ...owner, userId: "reader", role: "member" };
const path = "/api/internal/actions/v1/call";
const totals = "SELECT (SELECT sum(revision) FROM graph_nodes) n, (SELECT sum(revision) FROM graph_edges) e, (SELECT sum(revision) FROM graph_types) t";

test("graph.graphql answers generated-schema queries through the action dispatcher without writing", async () => {
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"));
  try {
    assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
    const create = (ref: string, type: string, attributes: object) => ({ operation: "create", ref, type, attributes });
    const apply = (requestKey: string, operations: object[]) => app.call(path, owner, { method: "POST", body: { action: "graph.apply", input: { requestKey, operations } } });
    const applied = await apply("graphql-fixture", [
      create("$seat", "graph-type", { category: "node", name: "QuerySeat", title: "Query seat", body: "Synthetic seat type.",
        properties: [{ name: "rank", type: "number", description: "Order." }] }),
      create("$holds", "graph-type", { category: "edge", name: "query_holds", title: "Holds", body: "A synthetic link.",
        properties: [{ name: "status", type: "string", description: "Link status." }] }),
      create("$a", "graph-node", { typeId: "$seat", title: "Seat A", properties: { rank: 1 } }),
      create("$b", "graph-node", { typeId: "$seat", title: "Seat B", properties: { rank: 2 } }),
      create("$edge", "graph-edge", { typeId: "$holds", fromId: "$a", toId: "$b", properties: { status: "active" } }),
    ]);
    assert.equal(applied.status, 200, await applied.clone().text());
    const ids = await applied.json() as Record<string, { id: string }>;
    await app.database.prepare("UPDATE graph_nodes SET externalId=? WHERE id=?").bind('never-return', ids.$a.id).run();
    // Endpoints declared after the fact: the next request has typed relationship fields.
    const typed = await apply("graphql-endpoints", [{ operation: "update", ref: "$holds", type: "graph-type", id: ids.$holds.id, revision: 1, attributes: {
      ontology: { version: 1, endpoints: { from: [ids.$seat.id], to: [ids.$seat.id] } } } }]);
    assert.equal(typed.status, 200, await typed.clone().text());

    const catalog = await (await app.call("/api/internal/actions/v1/list", member)).json() as { name: string; access: string; permitted: boolean; description?: string }[];
    const descriptor = catalog.find(action => action.name === "graph.graphql");
    assert.deepEqual(descriptor && { access: descriptor.access, permitted: descriptor.permitted }, { access: "read", permitted: true });
    // The description's examples run as copied on a seeded Wiki.
    const examples = [...String(descriptor?.description)
      .matchAll(/Example: (\{.*?\})\./g)].map(match => JSON.parse(match[1]) as { query: string });
    assert.equal(examples.length, 2);
    for (const example of examples) {
      const ran = graphGraphqlResult.parse(await (await app.call(path, member, { method: "POST", body: { action: "graph.graphql", input: example } })).json());
      assert.equal(ran.errors, undefined, `${example.query}: ${JSON.stringify(ran.errors)}`);
    }
    const before = await app.database.prepare(totals).all();
    const query = `query Seats($id: ID!) {
      querySeats { nodes { id title rank queryHolds { title } queryHoldsEdges { status to { title } } } aggregate { count } }
      node(id: $id) { __typename title ... on QuerySeat { queryHoldsIncoming { title } } edges { typeId } }
      __type(name: "QuerySeat") { name }
    }`;
    const response = await app.call(path, member, { method: "POST", body: { action: "graph.graphql", input: { query, variables: { id: ids.$b.id } } } });
    assert.equal(response.status, 200, await response.clone().text());
    const result = graphGraphqlResult.parse(await response.json());
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    assert.deepEqual(result.data, {
      querySeats: { nodes: [
        { id: ids.$a.id, title: "Seat A", rank: 1, queryHolds: [{ title: "Seat B" }], queryHoldsEdges: [{ status: "active", to: { title: "Seat B" } }] },
        { id: ids.$b.id, title: "Seat B", rank: 2, queryHolds: [], queryHoldsEdges: [] },
      ].sort((x, y) => (x.id < y.id ? -1 : 1)), aggregate: { count: 2 } },
      node: { __typename: "QuerySeat", title: "Seat B", queryHoldsIncoming: [{ title: "Seat A" }], edges: [{ typeId: ids.$holds.id }] },
      __type: { name: "QuerySeat" },
    });
    const full = await app.call(path, member, { method: "POST", body: { action: "graph.graphql", input: { query: "{ querySeats { nodes { properties body } } }" } } });
    assert.ok(!(await full.text()).includes("never-return"));
    const invalidQuery = graphGraphqlResult.parse(await (await app.call(path, member, { method: "POST", body: { action: "graph.graphql", input: { query: "{ nope }" } } })).json());
    assert.equal(invalidQuery.data, null, "GraphQL errors come back in GraphQL shape");
    assert.equal(invalidQuery.errors?.[0]?.extensions?.code, "GRAPHQL_VALIDATION_FAILED");
    assert.deepEqual((await app.database.prepare(totals).all()).results, before.results);
    const invalid = await app.call(path, member, { method: "POST", body: { action: "graph.graphql", input: { query: "", maxBytes: 1 } } });
    assert.equal(invalid.status, 400);
  } finally {
    await app.dispose();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { graphQueryResult } from "@ai-outfitter/app-sdk/graph-query";
import { knowledgeGraphTypeId } from "@ai-outfitter/app-sdk/graph-selection";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const member = { ...owner, userId: "reader", role: "member" };
const path = "/api/internal/actions/v1/call";

test("graph.query batches compact reads through the action dispatcher without writing", async () => {
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"));
  try {
    assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
    const create = (ref: string, type: string, attributes: object) => ({ operation: "create", ref, type, attributes });
    const applied = await app.call(path, owner, { method: "POST", body: { action: "graph.apply", input: {
      requestKey: "graph-query-fixture", operations: [
        create("$seat", "graph-type", { category: "node", name: "QuerySeat", title: "Query seat", body: "Synthetic seat type." }),
        create("$holds", "graph-type", { category: "edge", ontology: { version: 2, endpoints: { from: "any", to: "any" } }, name: "query_holds", title: "Holds", body: "A synthetic link." }),
        create("$a", "graph-node", { typeId: "$seat", title: "Seat A", body: "Long body ".repeat(50) }),
        create("$b", "graph-node", { typeId: "$seat", title: "Seat B" }),
        create("$edge", "graph-edge", { typeId: "$holds", fromId: "$a", toId: "$b" }),
        create("$lens", "graph-node", { typeId: knowledgeGraphTypeId, title: "Seat lens", properties: {
          root_type: "QuerySeat", pattern: JSON.stringify({ relationships: ["query_holds"], max_depth: 1 }),
        } }),
      ],
    } } });
    assert.equal(applied.status, 200, await applied.clone().text());
    const ids = await applied.json() as Record<string, { id: string }>;
    await app.database.prepare("UPDATE graph_nodes SET externalId=? WHERE id=?").bind('never-return', ids.$a.id).run();
    const catalog = await (await app.call("/api/internal/actions/v1/list", member)).json() as { name: string; access: string; permitted: boolean }[];
    const descriptor = catalog.find(action => action.name === "graph.query");
    assert.deepEqual(descriptor && { access: descriptor.access, permitted: descriptor.permitted }, { access: "read", permitted: true });
    const before = await app.database.prepare("SELECT (SELECT sum(revision) FROM graph_nodes) n, (SELECT sum(revision) FROM graph_edges) e, (SELECT sum(revision) FROM graph_types) t").all();
    const response = await app.call(path, member, { method: "POST", body: { action: "graph.query", input: { queries: [
      { name: "seats", types: ["QuerySeat"], expand: { edgeTypes: ["query_holds"], direction: "outgoing" } },
      { name: "inventory", entity: "all", aggregate: "type", types: ["QuerySeat", "query_holds"] },
      { name: "full", ids: [ids.$a.id], fields: "full" },
      { name: "saved", ids: [ids.$a.id], expand: { knowledgeGraphId: ids.$lens.id } },
      { name: "bySlug", slugs: ["seat-b", "nobody"], fields: ["slug"] },
    ] } } });
    assert.equal(response.status, 200, await response.clone().text());
    const result = graphQueryResult.parse(await response.json());
    assert.deepEqual(result.queries.seats.matches, [ids.$a.id, ids.$b.id].sort());
    assert.ok(result.queries.seats.related.includes(ids.$edge.id));
    assert.deepEqual(result.queries.inventory.counts?.filter(row => row.entity !== "type").map(row => [row.typeName, row.count]), [["query_holds", 1], ["QuerySeat", 2]]);
    assert.equal(result.nodes.find(node => node.id === ids.$a.id)?.body, "Long body ".repeat(50), "full projection merges into the deduplicated record");
    assert.deepEqual(result.queries.saved.related, [ids.$b.id, ids.$edge.id].sort(), "a saved KnowledgeGraph expands like its knowledge-graph selection");
    assert.ok(result.types.some(type => type.name === "QuerySeat" && typeof type.contractHash === "string"));
    assert.deepEqual([result.queries.bySlug.matches, result.queries.bySlug.total, result.nodes.find(node => node.id === ids.$b.id)?.slug], [[ids.$b.id], 1, "seat-b"], "nodes match by slug");
    assert.ok(!JSON.stringify(result).includes("never-return"));
    assert.deepEqual((await app.database.prepare("SELECT (SELECT sum(revision) FROM graph_nodes) n, (SELECT sum(revision) FROM graph_edges) e, (SELECT sum(revision) FROM graph_types) t").all()).results, before.results);
    const invalid = await app.call(path, member, { method: "POST", body: { action: "graph.query", input: { queries: [{ name: "x", entity: "all" }] } } });
    assert.equal(invalid.status, 400);
    const unsaved = await app.call(path, member, { method: "POST", body: { action: "graph.query", input: { queries: [{ name: "x", expand: { knowledgeGraphId: ids.$a.id } }] } } });
    assert.equal(unsaved.status, 404);
  } finally {
    await app.dispose();
  }
});

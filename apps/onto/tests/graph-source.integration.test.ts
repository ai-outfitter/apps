// The database GraphSource against the whole-graph read it replaced: graph.graphql and
// knowledge-graph.render's selection over D1 answer exactly what memorySource over readGraph and the
// in-memory selection walk answer, with more IDs than one D1 statement may bind.
import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { executeGraphQuery, graphGraphqlResult, memorySource, type TypeRow } from "@ai-outfitter/app-sdk/graph-graphql";
import { knowledgeGraphSelectResult, selectGraph, selectionResult } from "@ai-outfitter/app-sdk/graph-selection";
import { wikiGraphRecords } from "@ai-outfitter/app-sdk/graph-records";
import { drizzle } from "drizzle-orm/d1";
import { readGraph } from "../src/server/graph";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const path = "/api/internal/actions/v1/call";
const leaves = 130;

test("graph.graphql and knowledge-graph selections over D1 match the whole-graph read", async () => {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"));
  try {
    assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
    const call = async (action: string, input: object) => {
      const response = await app.call(path, owner, { method: "POST", body: { action, input } });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const create = (ref: string, type: string, attributes: object) => ({ operation: "create", ref, type, attributes });
    const types = await call("graph.apply", { requestKey: "source-types", operations: [
      create("$seat", "graph-type", { category: "node", name: "WideSeat", title: "Wide seat", body: "Synthetic." }),
      create("$link", "graph-type", { category: "edge", ontology: { version: 2, endpoints: { from: "any", to: "any" } }, name: "wide_link", title: "Wide link", body: "Synthetic." }),
    ] }) as Record<string, { id: string }>;
    await call("graph.apply", { requestKey: "source-endpoints", operations: [{ operation: "update", ref: "$link", type: "graph-type", id: types.$link.id, revision: 1,
      attributes: { ontology: { version: 1, endpoints: { from: [types.$seat.id], to: [types.$seat.id] } } } }] });
    // A hub linked to every leaf, and each leaf to the next: more IDs per hop than D1 binds per statement.
    const ids = Array.from({ length: leaves + 1 }, () => crypto.randomUUID());
    const nodes = ids.map((id, index) => create(`$n${index}`, "graph-node", { id, typeId: types.$seat.id, title: `Seat ${index}` }));
    const edges = ids.slice(1).flatMap((id, index) => [
      create(`$h${index}`, "graph-edge", { typeId: types.$link.id, fromId: ids[0], toId: id }),
      ...(index + 2 < ids.length ? [create(`$c${index}`, "graph-edge", { typeId: types.$link.id, fromId: id, toId: ids[index + 2] })] : []),
    ]);
    const operations = [...nodes, ...edges];
    for (let start = 0; start < operations.length; start += 100)
      await call("graph.apply", { requestKey: `source-${start}`, operations: operations.slice(start, start + 100) });
    await app.database.prepare("UPDATE graph_nodes SET archived=1 WHERE id=?").bind(ids[7]).run();
    await app.database.prepare("UPDATE graph_edges SET archived=1 WHERE fromId=? AND toId=?").bind(ids[0], ids[3]).run();

    const db = drizzle(app.database);
    const graph = await readGraph(db, { ...owner, installationId: "onto-installation", canEdit: true } as never);
    const snapshot = { installationId: "onto-installation", ...graph };
    const queries = [
      `{ wideSeats(first: 500) { nodes { id title wideLink { id } wideLinkIncoming { id } edges { id typeId fromId toId } } aggregate { count } } }`,
      `query($ids: [ID!]) { wideSeats(ids: $ids, archived: INCLUDE, first: 500) { nodes { id archived edges(types: ["wide_link"], direction: INCOMING, archived: ONLY) { id from { id } } } } }`,
      `{ search(text: "Seat 1", first: 50) { id title } node(id: "${ids[0]}") { edges(direction: OUTGOING, archived: INCLUDE) { id to { id title edges(direction: OUTGOING) { to { title } } } } } }`,
      `{ organizations { nodes { id title edges { id typeId from { id } to { id } } } } persons { aggregate { count } } }`,
      `query($slugs: [String!]) { wideSeat(slug: "seat-5") { id slug wideLink { slug } } node(slug: "seat-7", archived: INCLUDE) { id } wideSeats(slugs: $slugs, ids: ["${ids[1]}", "${ids[2]}"]) { nodes { slug } aggregate { count } } }`,
    ];
    for (const query of queries) {
      const variables = { ids: ids.slice(0, 120), slugs: ["seat-1", "seat-2", "seat-3", "nobody"] };
      const expected = await executeGraphQuery({ types: graph.types as unknown as TypeRow[], source: memorySource(snapshot), query, variables, maxBytes: 262144 });
      const actual = graphGraphqlResult.parse(await call("graph.graphql", { query, variables, maxBytes: 262144 }));
      assert.equal(actual.errors, undefined, JSON.stringify(actual.errors));
      assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)), query);
    }

    const records = wikiGraphRecords(snapshot, true);
    const definition = { id: "wide", version: 1, purpose: "Every seat.", rootTypes: ["WideSeat"], terminalTypes: [], stopAtTypes: [], stopAfterTypes: [], maxDepth: 4, maxNodes: 200,
      relationships: [{ type: "wide_link", direction: "outgoing" as const }, { type: "wide_link", direction: "incoming" as const }] };
    const outgoing = { ...definition, relationships: [definition.relationships[0]] };
    // The selection knowledge-graph.render reads before it flattens.
    const bare = { version: 1, order: 0, name: "Bare", bindings: {}, sections: [{ heading: "Selection", fields: [] }] };
    const select = async (bounded: typeof definition, rootIds: string[]) => {
      const { query, hash, variables, ...actual } = knowledgeGraphSelectResult.parse((await call("knowledge-graph.render", { definition: bounded, rootIds, templates: [bare] }) as { selection: unknown }).selection);
      assert.ok(query && hash && variables);
      return { actual, expected: knowledgeGraphSelectResult.parse(selectionResult(records, selectGraph(records, rootIds, bounded), null)) };
    };
    const cases = [
      [outgoing, [ids[0]], 3, 200], [outgoing, [ids[0]], 2, 50], [outgoing, [ids[5], ids[60]], 4, 6], [definition, [ids[130]], 2, 200], [definition, [ids[130]], 4, 3],
    ] as const;
    for (const [base, rootIds, maxDepth, maxNodes] of cases) {
      const { actual, expected } = await select({ ...base, maxDepth, maxNodes }, [...rootIds]);
      assert.deepEqual(actual, expected, `from ${rootIds.join(", ")}`);
    }
    // Four hops from the hub repeat each seat at every path to it, so the 5,000-record read
    // budget runs out first: fewer records than the in-memory walk, and marked incomplete.
    const { actual, expected } = await select(definition, [ids[0]]);
    const kept = new Set(expected.nodes.map(node => node.ref.id));
    assert.equal(actual.incomplete, true);
    assert.ok(actual.nodes.length < expected.nodes.length && actual.nodes.every(node => kept.has(node.ref.id)));
  } finally {
    await app.dispose();
  }
});

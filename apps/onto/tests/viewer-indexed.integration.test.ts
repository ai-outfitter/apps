// The indexed Wiki source against the whole-graph read it replaced: the viewer's Wiki
// document (outfitter_whoami) answers over it what it answers over the whole graph,
// graph.query's filters, expansions and cursors answer exactly what queryGraph over
// readGraph answers, and no statement reads a whole table.
import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { type GraphQuery, type GraphQueryInput, type GraphQueryResult, queryGraph } from "@ai-outfitter/app-sdk/graph-query";
import { knowledgeGraphTypeId } from "@ai-outfitter/app-sdk/graph-selection";
import { wikiGraphRecords } from "@ai-outfitter/app-sdk/graph-client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { executeGraphQuery, memorySource } from "@ai-outfitter/app-sdk/graph-graphql";
import { type ViewerWikiData, viewerWikiDocument, wikiView } from "./fixtures/viewer-document";
import { crowdedViewerGraph, viewerFixtureIds } from "./fixtures/viewer-graph-fixture.mjs";
import { storeType } from "../src/lib/type-metadata";
import { readGraph } from "../src/server/graph";
import { graphqlGraphRecords } from "../src/server/graph-graphql";
import { queryGraphRecords } from "../src/server/graph-query";
import { savedDefinition } from "../src/server/knowledge-graph-select";
import { graphEdges, graphNodes, graphTypes } from "../src/server/schema";

const identity = { userId: "owner", organizationId: "org", role: "owner", installationId: "east-wiki", canEdit: false } as never;
const now = Date.parse("2026-11-01T00:00:00Z");
const lens = "00000000-0000-4000-8000-000000000901";

test("graph.query reads only the rows each query needs and answers what the whole-graph read answers", async () => {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"));
  try {
    const graph = crowdedViewerGraph(400);
    const db = drizzle(app.database);
    const stamp = { createdAt: 0, updatedAt: 0 };
    const types = [...graph.types, { id: knowledgeGraphTypeId, category: "node", name: "KnowledgeGraph", title: "KnowledgeGraph", properties: [] }];
    // Only the fixture: the seeded types share its names.
    for (const table of [graphEdges, graphNodes, graphTypes]) await db.delete(table);
    for (const type of types) await db.insert(graphTypes).values({ ...storeType({ body: "", ...type } as never), ...stamp } as never);
    const nodes = [...graph.nodes, { id: lens, typeId: knowledgeGraphTypeId, revision: 1, title: "Goal lens",
      properties: { root_type: "Goal", pattern: JSON.stringify({ relationships: [{ type: "pursues", direction: "incoming" }, "measured_by"], max_depth: 2 }) } }];
    // D1 binds at most 100 parameters per statement.
    for (let at = 0; at < nodes.length; at += 4) await db.insert(graphNodes).values(nodes.slice(at, at + 4).map(row => ({ slug: row.id, ...stamp, ...row }) as never));
    for (let at = 0; at < graph.edges.length; at += 6) await db.insert(graphEdges).values(graph.edges.slice(at, at + 6).map(row => ({ ...stamp, ...row }) as never));
    await db.update(graphNodes).set({ archived: true }).where(eq(graphNodes.id, graph.nodes[4].id));

    const whole = async (input: GraphQueryInput) => {
      const read = await readGraph(db, identity);
      const snapshot = { installationId: "east-wiki", ...read };
      return queryGraph(snapshot, input, { knowledgeGraph: id => {
        const row = read.nodes.find(node => node.id === id);
        return savedDefinition(row ? wikiGraphRecords({ ...snapshot, nodes: [row], edges: [] }, true).nodes[0] ?? null : null);
      } });
    };
    const statements: string[] = [];
    const counted = new Proxy(app.database, { get(target, key) {
      if (key === "prepare") return (sql: string) => { statements.push(sql); return target.prepare(sql); };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const indexed = async (input: GraphQueryInput) => {
      statements.length = 0;
      const actual = await queryGraphRecords(drizzle(counted), identity, input);
      for (const sql of statements) assert.ok(/graph_types/.test(sql) || / where /i.test(sql), `whole-table read: ${sql}`);
      assert.deepEqual(actual, await whole(input));
      return { actual, statements: statements.length };
    };

    // The viewer's one Wiki document answers over the indexed source what it answers over the whole graph.
    const variables = { holder: viewerFixtureIds.person, at: new Date(now).toISOString() };
    statements.length = 0;
    const answer = await graphqlGraphRecords(drizzle(counted), identity, { query: viewerWikiDocument, variables, maxBytes: 128 * 1024 });
    for (const sql of statements) assert.ok(/graph_types/.test(sql) || / where /i.test(sql), `whole-table read: ${sql}`);
    const source = memorySource({ installationId: "east-wiki", ...await readGraph(db, identity) } as never);
    assert.deepEqual(answer, await executeGraphQuery({ types: await source.types(), source, query: viewerWikiDocument, variables, maxBytes: 128 * 1024 }));
    assert.equal(answer.extensions?.truncated, undefined);
    assert.deepEqual(wikiView(answer.data as ViewerWikiData).commitments.map(row => [row.id, row.openObligations]), [["00000000-0000-4000-8000-000000000111", 1]]);
    console.log(`D1 statements for the viewer's Wiki document: ${statements.length}`);

    const edges = (name: string, query: Partial<GraphQuery>): GraphQuery => ({ name, entity: "edge", ...query } as GraphQuery);
    const cases: GraphQueryInput[] = [
      { queries: [{ name: "people", text: "person 1", limit: 7, fields: "full" }, edges("links", { text: "observed" }), { name: "kinds", entity: "all", aggregate: "type", types: ["Role", "assigns_role"] }] },
      { queries: [{ name: "archived", archived: "only" }, { name: "every", archived: "include", ids: [graph.nodes[4].id, graph.nodes[5].id, "missing"] }, { name: "types", entity: "type", types: ["Goal", "nope"] }] },
      { queries: [{ name: "lens", types: ["Goal"], expand: { knowledgeGraphId: lens } }, { name: "inline", ids: [viewerFixtureIds.role], expand: { relationships: ["pursues", { type: "assigns_role", direction: "incoming" }], maxDepth: 3, maxNodes: 8 } }] },
      // One hop: each assignment's holder is past the depth, so omitted, which needs it read.
      { queries: [{ name: "shallow", ids: ["00000000-0000-4000-9000-000000000013", "00000000-0000-4000-9000-000000000033"], expand: { edgeTypes: ["assigns_role", "assigned_to"], depth: 1 } }, edges("held", { ids: [graph.edges[0].id, graph.edges[1].id] })] },
      { queries: [{ name: "roles", types: ["Role"], expand: { edgeTypes: ["assigns_role", "assigned_to", "missing_link"], depth: 2, maxNodes: 5 }, limit: 30 }], maxBytes: 8 * 1024 },
      // More matches than queryGraph expands in one request (100).
      { queries: [{ name: "many", types: ["Person"], expand: { edgeTypes: ["assigned_to"], depth: 1 }, limit: 150 }], maxBytes: 256 * 1024 },
    ];
    for (const input of cases) await indexed(input);
    // A cursor resumes over the indexed source as it did over the whole graph.
    let page: GraphQueryResult = (await indexed({ queries: [{ name: "people", types: ["Person"], limit: 150 }] })).actual;
    for (let pages = 1; page.queries.people.cursor; pages++) {
      assert.ok(pages < 5);
      page = (await indexed({ queries: [{ name: "people", types: ["Person"], limit: 150, cursor: page.queries.people.cursor }] })).actual;
    }
  } finally {
    await app.dispose();
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSchema, parse, validate } from "graphql";
import { contextDefinition } from "../src/lib/knowledge-graphs";
import { nodeBodyLimit, seedQueries } from "../scripts/knowledge-graph-queries";
import { standardData } from "../src/lib/standard-data";
import { executeGraphQuery, memorySource, selectFromResult, type TypeRow } from "@ai-outfitter/app-sdk/graph-graphql";
import { knowledgeGraphTypeId, selectGraph } from "@ai-outfitter/app-sdk/graph-selection";
import { loadKnowledgeGraph } from "@ai-outfitter/app-sdk/knowledge-graph";
import { wikiGraphRecords } from "@ai-outfitter/app-sdk/graph-records";
import { demoGraph } from "../fixtures/graph";
import { knowledgeGraphDefinition, selectionReadBudget, withCompiledQuery } from "../src/lib/knowledge-graph-document";

const standardSchema = buildSchema(readFileSync(new URL("../../../packages/app-sdk/graph/standard-schema.graphql", import.meta.url), "utf8"));

test("seed knowledge graphs ship their compiled GraphQL document, valid against the standard schema", async () => {
  assert.equal((await seedQueries()).stale, false, "run node --import tsx apps/onto/scripts/knowledge-graph-queries.ts");
  const saved = standardData.nodes.flatMap((node) => {
    const definition = node.typeId === knowledgeGraphTypeId && !node.archived ? contextDefinition(node) : undefined;
    return definition ? [{ node, query: definition.query ?? "" }] : [];
  });
  assert.deepEqual(saved.map((item) => item.node.title), ["Role operating context", "Decision context", "Delivery context", "Organization overview", "Competitive landscape", "Release scope", "Product chain"]);
  for (const { node, query } of saved) {
    assert.deepEqual(validate(standardSchema, parse(query)).map((error) => error.message), [], node.title);
    assert.ok(node.body.length <= nodeBodyLimit * 0.85, `${node.title} leaves room inside the node body limit (${node.body.length})`);
    // A seed with both a selection and its query is a valid lens in the page's lens list.
    assert.doesNotThrow(() => loadKnowledgeGraph(standardData as never, node as never), node.title);
  }
  assert.match(saved[3].query, /^query OrganizationOverview\(\$rootIds: \[ID!\]!\) \{\n {2}organizations\(ids: \$rootIds, first: 200\)/m);
});

test("stored seed queries read the demo Wiki exactly as the in-memory selection walk", async () => {
  const types = [...new Map([...standardData.types, ...demoGraph.types].map((type) => [type.id, type])).values()] as unknown as TypeRow[];
  const snapshot = { installationId: "demo", types, nodes: [...demoGraph.nodes, ...standardData.nodes.filter((node) => !demoGraph.nodes.some((own) => own.id === node.id))], edges: demoGraph.edges };
  const graph = wikiGraphRecords(snapshot as never, true);
  const ids = (selection: ReturnType<typeof selectGraph>) => [selection.nodes, selection.edges, selection.omitted].map((list) => list.map((item) => ("ref" in item ? item.ref.id : item.id)));
  let largest = 0;
  for (const slug of ["organization-overview", "delivery-context", "role-context", "decision-context"]) {
    const record = graph.nodes.find((node) => node.attributes.slug === slug) ?? assert.fail(slug);
    const definition = knowledgeGraphDefinition(record) ?? assert.fail(slug);
    const query = String(contextDefinition({ body: String(record.attributes.body) })?.query);
    const typeIds = new Set(types.filter((type) => definition.rootTypes.includes(type.name)).map((type) => type.id));
    for (const root of graph.nodes.filter((node) => typeIds.has(String(node.attributes.typeId))).slice(0, 4)) {
      const read = await executeGraphQuery({ types, source: memorySource(snapshot as never), query, variables: { rootIds: [root.ref.id] }, ...selectionReadBudget });
      assert.equal(read.errors, undefined, `${slug}: ${JSON.stringify(read.errors)}`);
      const selection = selectFromResult({ installationId: "demo", types, data: read.data, rootIds: [root.ref.id], definition });
      const direct = selectGraph(graph, [root.ref.id], definition);
      assert.deepEqual(ids(selection), ids(direct), `${slug} from ${root.title}`);
      largest = Math.max(largest, direct.nodes.length);
    }
  }
  assert.ok(largest >= 15, "the demo Wiki exercises more than a root and its neighbours");
});

test("a saved selection with the node budget graph_search allows (up to 500) compiles to a stored document", () => {
  const body = { name: "Landscape", purpose: "Competitors", rootTypes: ["Organization"], selection: { relationships: ["offered_by"], maxDepth: 2, maxNodes: 300 } };
  const node = { id: "landscape", title: "Landscape", revision: 1, body: JSON.stringify(body) };
  const compiled = withCompiledQuery(node, standardData.types as unknown as TypeRow[]);
  assert.notEqual(compiled, node);
  assert.match(JSON.parse(compiled.body).query, /^query Landscape\(/);
});

test("compiled KnowledgeGraphs remain bounded before storage", async () => {
  const { nodeInput } = await import("@ai-outfitter/app-sdk/graph-contracts");
  const { withCompiledQuery } = await import("../src/lib/knowledge-graph-document");
  const node = { typeId: "71000000-0000-4000-8000-000000000001", title: "Bounded", body: "x".repeat(65_536) };
  assert.equal(nodeInput.safeParse(node).success, true);
  assert.equal(nodeInput.safeParse({ ...node, body: `${node.body}x` }).success, false);
  const types = [
    { id: "root", name: "Root", category: "node" as const, archived: false },
    ...Array.from({ length: 32 }, (_, i) => ({ id: `edge-${i}`, name: `relationship_${i}_${"a".repeat(70)}`, category: "edge" as const, archived: false })),
  ];
  const body = JSON.stringify({ name: "Bounded", purpose: "Exercise the compiled document limit.", rootTypes: ["Root"], selection: { relationships: types.slice(1).map((type) => type.name), maxDepth: 10, maxNodes: 20 } });
  const input = { id: "lens", title: "Bounded", body };
  assert.throws(() => withCompiledQuery(input, types), (error: unknown) => error instanceof Response && error.status === 413);
  assert.equal(input.body, body, "refusal does not mutate the input");
});

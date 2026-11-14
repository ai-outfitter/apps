import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parse, print } from "graphql";
import { definitionFromResult, executeGraphQuery, queryHash, memorySource, resultRecords, selectFromResult, selectionDocument, selectionQueryDepth, type TypeRow } from "../src/graph-graphql";
import { type GraphSelection, type GraphSelectionDefinition, graphSelectionDefinition, selectGraph } from "../src/graph-selection";
import { wikiGraphRecords } from "../src/graph-records";
import type { z } from "zod";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const type = (n: number, name: string, category: "node" | "edge", extra: Record<string, unknown> = {}) =>
  ({ id: uuid(n), name, category, title: name, body: "", properties: [], archived: false, revision: 1, createdAt: n, ...extra });
const ends = (from: number[], to: number[]) => ({ version: 2, endpoints: { from: from.map(uuid), to: to.map(uuid) } });
const types = [
  type(1, "Organization", "node"), type(2, "Project", "node"), type(3, "Product", "node"), type(4, "Problem", "node"), type(5, "CustomerSegment", "node"),
  type(11, "part_of", "edge"), type(12, "produces", "edge", { ontology: ends([2], [3]) }), type(13, "addresses", "edge"),
  type(14, "experiences", "edge", { ontology: ends([5], [4]) }), type(15, "developed_by", "edge"), type(16, "Retired", "node", { archived: true }),
] as TypeRow[];
const node = (n: number, typeId: number, title: string, extra: Record<string, unknown> = {}) =>
  ({ id: uuid(100 + n), typeId: uuid(typeId), slug: `n${n}`, title, summary: "", body: "", properties: {}, archived: false, revision: 1, createdAt: 1, updatedAt: 1, ...extra });
const edge = (n: number, typeId: number, from: number, to: number, extra: Record<string, unknown> = {}) =>
  ({ id: uuid(200 + n), typeId: uuid(typeId), fromId: uuid(100 + from), toId: uuid(100 + to), title: "", body: "", properties: {}, archived: false, revision: 1, createdAt: 1, updatedAt: 1, ...extra });
const snapshot = {
  installationId: "wiki", types,
  nodes: [
    node(1, 1, "Acme"), node(2, 1, "Rival"), node(3, 2, "Atlas"), node(4, 2, "Beacon"), node(5, 2, "Rival project"), node(6, 3, "Atlas app"), node(7, 3, "Beacon kit"),
    node(8, 4, "Slow onboarding"), node(9, 5, "Small teams"), node(10, 4, "Old problem", { properties: { status: "retired" } }), node(11, 2, "Archived project", { archived: true }),
    node(12, 4, "Pricing"),
  ],
  edges: [
    edge(1, 11, 3, 1), edge(2, 11, 4, 1), edge(3, 11, 5, 2), edge(4, 12, 3, 6), edge(5, 12, 4, 7), edge(6, 15, 6, 2), edge(7, 13, 6, 8), edge(8, 13, 4, 12),
    edge(9, 14, 9, 8), edge(10, 13, 7, 10), edge(11, 11, 11, 1), edge(12, 11, 3, 1, { archived: true }),
  ],
};
const graph = wikiGraphRecords(snapshot as never, true);
const definition = (extra: Partial<z.input<typeof graphSelectionDefinition>>) => graphSelectionDefinition.parse({ id: "test", version: 1, rootTypes: ["Organization"], maxDepth: 4, maxNodes: 100, relationships: [], ...extra });
const ids = (selection: GraphSelection) => ({
  nodes: selection.nodes.map(item => item.ref.id), edges: selection.edges.map(item => item.ref.id), omitted: selection.omitted.map(ref => ref.id),
  depth: Object.fromEntries(selection.depth), incomplete: selection.incomplete,
});
async function roundTrip(selection: GraphSelectionDefinition, rootIds = [uuid(101)]) {
  const compiled = selectionDocument(selection, types);
  const roots = rootIds.map(id => snapshot.nodes.find(row => row.id === id)!.slug);
  const result = await executeGraphQuery({ types, source: memorySource(snapshot as never), query: compiled.query, variables: { rootIds }, maxBytes: 1 << 20, maxDepth: selectionQueryDepth(selection.maxDepth), maxFields: 1e7 });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  const read = selectFromResult({ installationId: "wiki", types, data: result.data, rootIds, definition: selection });
  const direct = selectGraph(graph, rootIds, selection);
  assert.deepEqual(ids(read), ids(direct));
  return { compiled, data: result.data, direct };
}
const titles = (selection: GraphSelection) => selection.nodes.map(item => item.title).sort((a, b) => a.localeCompare(b));

test("an incoming relationship, typed endpoint fields and generic edges read the same selection as selectGraph", async () => {
  const { compiled, direct } = await roundTrip(definition({ relationships: [{ type: "part_of", direction: "incoming" }, "produces", "addresses", { type: "experiences", direction: "incoming" }] }));
  assert.deepEqual(titles(direct), ["Acme", "Atlas", "Atlas app", "Beacon", "Beacon kit", "Pricing", "Slow onboarding", "Small teams"]);
  assert.match(compiled.query, /\.\.\. on Project \{\s+producesEdges \{\s+\.\.\.Link\s+to \{/, "edge types with endpoints use their typed fields");
  assert.match(compiled.query, /\.\.\. on Problem \{\s+experiencesIncomingEdges \{\s+\.\.\.Link\s+from/);
  assert.match(compiled.query, /partOfIncomingLinks: edges\(types: \["part_of"\], direction: INCOMING\)/, "others read the edges connection");
  assert.match(compiled.query, /organizations\(ids: \$rootIds, first: 100\)/);
  assert.equal(print(parse(compiled.query)), compiled.query, "the text is graphql-js print output");
  assert.match(compiled.query, /fragment Record on Node \{\s+id\s+typeId\s+title\s+slug\s+\}/, "every record carries its slug");
  assert.equal(compiled.variables.required[0], "rootIds", "roots are named by stable IDs");
  for (const text of [compiled.query, "", "abc", "x".repeat(55), "x".repeat(64), "é漢🙂".repeat(300)])
    assert.equal(queryHash(text), createHash("sha256").update(text).digest("hex"), "queryHash is sha256 hex of the UTF-8 text");
  assert.equal(parse(compiled.query).definitions.filter(item => item.kind === "FragmentDefinition").length, 2 + 5, "Record, Link, Step1-4 and Beyond");
});

test("terminal types stop expansion and endpoint guards keep stored directions", async () => {
  const terminal = await roundTrip(definition({ relationships: [{ type: "part_of", direction: "incoming" }, "produces", "addresses", "developed_by"], terminalTypes: ["Product"] }));
  assert.deepEqual(titles(terminal.direct), ["Acme", "Atlas", "Atlas app", "Beacon", "Beacon kit", "Pricing"]);
  assert.doesNotMatch(terminal.compiled.query, /\.\.\. on Product/, "a terminal type carries no fields");
  const guarded = await roundTrip(definition({ maxDepth: 5, relationships: [
    { type: "part_of", direction: "incoming", from_type: "Project", to_type: "Organization" }, { type: "produces", from_type: "Project", to_type: "Product" },
    { type: "developed_by", from_type: "Product", to_type: "Organization" }, { type: "part_of", direction: "incoming", from_type: "Project", to_type: "Organization" },
  ] }));
  assert.deepEqual(titles(guarded.direct), ["Acme", "Atlas", "Atlas app", "Beacon", "Beacon kit", "Rival", "Rival project"]);
  assert.match(guarded.compiled.query, /\.\.\. on Product \{\s+developedByLinks: edges/);
  assert.doesNotMatch(guarded.compiled.query, /\n {2}developedByLinks/, "a source guard places the field on that type only");
});

test("budgets and the depth limit report omitted records as selectGraph does", async () => {
  const rules = [{ type: "part_of", direction: "incoming" as const }, "produces", "addresses", "developed_by"];
  const small = await roundTrip(definition({ relationships: rules, maxNodes: 3 }));
  assert.equal(small.direct.nodes.length, 3);
  assert.ok(small.direct.omitted.length > 0);
  const shallow = await roundTrip(definition({ relationships: rules, maxDepth: 1 }));
  assert.deepEqual(shallow.direct.omitted.map(ref => ref.id), [uuid(106), uuid(107), uuid(112)], "the Beyond hop names what lies past the limit");
  await roundTrip(definition({ relationships: rules, rootTypes: ["Organization", "Project"] }), [uuid(101), uuid(105)]);
  assert.throws(() => selectionDocument(definition({ relationships: rules, rootTypes: ["Unknown"] }), types), /No root type/);
});

test("a hand-written document selects what it returns, read through a derived definition", async () => {
  const query = `query($rootIds: [ID!]!) { organizations(ids: $rootIds) { nodes { id typeId title
    edges(types: ["part_of"], direction: INCOMING) { id typeId fromId toId from { id typeId title ... on Project { producesEdges { id typeId fromId toId to { id typeId title } } } } } } } }`;
  const result = await executeGraphQuery({ types, source: memorySource(snapshot as never), query, variables: { rootIds: [uuid(101)] }, maxBytes: 1 << 20 });
  const derived = definitionFromResult(result.data, types, [uuid(101)], { maxNodes: 50 });
  assert.deepEqual(derived.relationships, [{ type: "part_of", direction: "incoming" }, { type: "produces", direction: "outgoing" }]);
  assert.deepEqual([derived.rootTypes, derived.maxDepth], [["Organization"], 2]);
  const read = selectFromResult({ installationId: "wiki", types, data: result.data, rootIds: [uuid(101)], definition: derived });
  assert.deepEqual(titles(read), ["Acme", "Atlas", "Atlas app", "Beacon", "Beacon kit"]);
  assert.equal(read.edges.length, 4);
  assert.equal(resultRecords({ a: { id: "x", typeId: "t", properties: { id: "y", typeId: "t" } } }).nodes.length, 1, "stored JSON is not read as records");
});

import assert from "node:assert/strict";
import test from "node:test";
import standard from "../seeds/knowledge-graphs-v1.json";
import { definitionQuery, graphQueryParams, parseGraphQuery, queryDefinition, type SelectionDefinition } from "../src/lib/knowledge-graph-query";
import { knowledgeGraphDefinitionSchema } from "../src/lib/knowledge-graphs";

test("URL params become a bounded graph query and round-trip", () => {
  const query = parseGraphQuery(new URLSearchParams("rel=has_mission_objective&rel=part_of:incoming&rel=bad:sideways&rel=a/b&depth=40&max=0"));
  assert.deepEqual(query, {
    relationships: [{ type: "has_mission_objective", direction: "outgoing" }, { type: "part_of", direction: "incoming" }],
    maxDepth: 10,
    maxNodes: 100,
    stopAtTypes: [],
    stopAfterTypes: [],
  });
  assert.equal(graphQueryParams(query!).toString(), "rel=has_mission_objective&rel=part_of%3Aincoming&depth=10&max=100");
  assert.deepEqual(parseGraphQuery(graphQueryParams(query!)), query);
  assert.equal(parseGraphQuery(new URLSearchParams("depth=2")), null);
});

test("type ends, stop types and the adjusted graph round-trip through the address", () => {
  const params = new URLSearchParams();
  for (const rel of ["part_of:incoming:Project>Organization", "alternative_for:incoming", "developed_by:Product>", "part_of:>Product", "x:A>B>C", "y:incoming:A", "z:Bad/Type>B"]) params.append("rel", rel);
  for (const stop of ["Organization", "Organization", "bad/type"]) params.append("stop", stop);
  params.append("after", "Offering");
  params.set("graph", "fe6b93a0-67c5-5287-b254-a43c25a231e8");
  const query = parseGraphQuery(params)!;
  assert.deepEqual(query.relationships, [
    { type: "part_of", direction: "incoming", from_type: "Project", to_type: "Organization" },
    { type: "alternative_for", direction: "incoming" },
    { type: "developed_by", direction: "outgoing", from_type: "Product" },
    { type: "part_of", direction: "outgoing", to_type: "Product" },
  ]);
  assert.deepEqual(query.stopAtTypes, ["Organization"]);
  assert.deepEqual(query.stopAfterTypes, ["Offering"]);
  assert.equal(query.graphId, "fe6b93a0-67c5-5287-b254-a43c25a231e8");
  assert.deepEqual(parseGraphQuery(graphQueryParams(query)), query);
  assert.equal(parseGraphQuery(new URLSearchParams("rel=a&graph=../x"))?.graphId, undefined);
});

test("a query saves as a valid knowledge graph definition", () => {
  const query = parseGraphQuery(new URLSearchParams("rel=objective_measured_by&stop=Problem&depth=3&max=50"))!;
  const definition = queryDefinition(query, { rootTypes: ["Project"], name: "Mission measures", purpose: "Projects and how their objectives are measured." });
  assert.deepEqual(knowledgeGraphDefinitionSchema.parse(definition).selection, {
    relationships: [{ type: "objective_measured_by", direction: "outgoing" }],
    maxDepth: 3,
    maxNodes: 50,
    stopAtTypes: ["Problem"],
  });
});

test("adjusting the standard competitive landscape keeps every step and stop type", () => {
  const node = standard.nodes.find((candidate) => candidate.slug === "competitive-landscape")!;
  const saved = knowledgeGraphDefinitionSchema.parse(JSON.parse(node.body)) as SelectionDefinition;
  const reread = parseGraphQuery(graphQueryParams(definitionQuery(saved, node.id)))!;
  assert.equal(reread.graphId, node.id);
  // The update stores the selection; its GraphQL document is compiled again when it is read.
  const { query: _query, hash: _hash, variables: _variables, ...selection } = saved;
  assert.deepEqual(queryDefinition(reread, saved), selection);
});

test("a stored step whose types this Wiki lacks is kept for the update", () => {
  const saved = <SelectionDefinition>knowledgeGraphDefinitionSchema.parse({ name: "Decisions", purpose: "Decision context.", rootTypes: ["Project"],
    selection: { relationships: ["decided_by", { type: "governs", direction: "incoming", from_type: "Control" }], maxDepth: 2, maxNodes: 50, stopAtTypes: ["Charter"] } });
  const query = parseGraphQuery(graphQueryParams(definitionQuery(saved)))!;
  assert.deepEqual(queryDefinition(query, saved).selection, {
    relationships: [{ type: "decided_by", direction: "outgoing" }, { type: "governs", direction: "incoming", from_type: "Control" }],
    maxDepth: 2, maxNodes: 50, stopAtTypes: ["Charter"],
  });
});

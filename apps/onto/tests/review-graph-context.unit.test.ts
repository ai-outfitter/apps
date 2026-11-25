import assert from "node:assert/strict";
import test from "node:test";
import { compileAuthoredGraphs } from "@ai-outfitter/app-sdk/graph-authoring";
import { demoGraph } from "../fixtures/graph";
import { defaultTypes } from "../src/lib/default-types";
import { reviewGraphContext } from "../src/server/review-graph-context";

test("saved manager path and actual supplier endpoint contract inform review of notice and supply edges", async () => {
  const [fixture] = await compileAuthoredGraphs([{
    namespace: "review-fixture",
    types: [{
      name: "manages", category: "edge", title: "Manages", body: "An example management relationship.",
      ontology: { version: 2, endpoints: { from: ["onto:Person"], to: ["onto:Organization"] } },
    }],
    nodes: [
      { typeId: "onto:Person", slug: "avery", title: "Avery" },
      { typeId: "onto:Organization", slug: "fixture-company", title: "Fixture Company" },
      { typeId: "onto:Product", slug: "fitting", title: "Fitting" },
    ],
    edges: [{
      key: "manager-assignment", typeId: "review-fixture:manages",
      fromId: "review-fixture:Person:avery", toId: "review-fixture:Organization:fixture-company",
    }],
  }, { namespace: "onto", types: defaultTypes }]);
  const graph = {
    ...demoGraph,
    types: [...demoGraph.types, ...fixture.types.map(type => ({ ...demoGraph.types[0], ...type }))],
    nodes: fixture.nodes.map(node => ({ ...demoGraph.nodes[0], ...node })),
    edges: fixture.edges.map(edge => ({ ...demoGraph.edges[0], ...edge })),
  };
  const person = fixture.nodes[0].id;
  const row = { ref: "$supply", state: "pending", operation: { type: "graph-edge", attributes: {
    typeId: "supplied_by", fromId: "Product:fitting", toId: "Organization:fixture-company",
  } } };
  const check = reviewGraphContext(graph, [row], person);
  assert.equal(check(row).endpointsAllowed, true);
  assert.equal(check(row).reachableFromOwner, true);
  assert.equal(check({ ref: "$company", state: "pending", operation: {
    type: "graph-node", id: "Organization:fixture-company", attributes: {},
  } }).reachableFromOwner, true);
  const reverse = { ...row, operation: { ...row.operation, attributes: { ...row.operation.attributes,
    fromId: "Organization:fixture-company", toId: "Product:fitting",
  } } };
  assert.equal(reviewGraphContext(graph, [reverse], person)(reverse).endpointsAllowed, false);
  const withoutManagement = { ...graph, edges: [] };
  assert.equal(reviewGraphContext(withoutManagement, [row], person)(row).reachableFromOwner, false);
});

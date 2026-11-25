import assert from "node:assert/strict";
import test from "node:test";
import { demoGraph } from "../fixtures/graph";
import { reviewGraphContext } from "../src/server/review-graph-context";

test("saved manager path and actual supplier endpoint contract inform review of notice and supply edges", () => {
  const type = (name: string) => demoGraph.types.find(t => t.name === name)!;
  const person = "71011000-0000-4000-8000-000000000001", vendor = "71011000-0000-4000-8000-000000000002";
  const product = "71011000-0000-4000-8000-000000000003";
  const node = (id: string, kind: string, title: string) => ({ ...demoGraph.nodes[0], id, typeId: type(kind).id, title, slug: title.toLowerCase() });
  const management = { ...type("supplied_by"), name: "manages", id: "71011000-0000-4000-8000-000000000010",
    ontology: { version: 2 as const, endpoints: { from: [type("Person").id], to: [type("Organization").id] } } };
  const graph = { ...demoGraph, types: [...demoGraph.types, management], nodes: [
    node(person, "Person", "Avery"), node(vendor, "Organization", "Fixture Company"), node(product, "Product", "Fitting"),
  ], edges: [{ ...demoGraph.edges[0], archived: false, typeId: management.id, fromId: person, toId: vendor }] };
  const row = { ref: "$supply", state: "pending", operation: { type: "graph-edge", attributes: { typeId: type("supplied_by").id, fromId: product, toId: vendor } } };
  const check = reviewGraphContext(graph, [row], person);
  assert.equal(check(row).endpointsAllowed, true);
  assert.equal(check(row).reachableFromOwner, true);
  assert.equal(check({ ref: "$company", state: "pending", operation: { type: "graph-node", id: vendor, attributes: {} } }).reachableFromOwner, true);
  const reverse = { ...row, operation: { ...row.operation, attributes: { ...row.operation.attributes, fromId: vendor, toId: product } } };
  assert.equal(reviewGraphContext(graph, [reverse], person)(reverse).endpointsAllowed, false);
  const withoutManagement = { ...graph, edges: [] };
  assert.equal(reviewGraphContext(withoutManagement, [row], person)(row).reachableFromOwner, false);
});

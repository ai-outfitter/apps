import assert from "node:assert/strict";
import test from "node:test";
import { bodyGraphReferences } from "../src/lib/body-graph-references";
import { wikiGraph } from "@ai-outfitter/onto/contracts";
import {
  auditOntology,
  requireOntologyValid,
} from "../src/lib/ontology-validation";

const id = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const schema = {
  type: "object",
  properties: {
    dependency: {
      type: "object",
      "x-wiki-graph-path": true,
      properties: {
        name: { type: "string" },
        min_matches: { type: "integer" },
        path: { type: "array", items: { type: "object" } },
      },
    },
    type_id: { type: "string", "x-wiki-reference": "node-type" },
  },
  required: ["dependency", "type_id"],
  additionalProperties: false,
};
const fixture = () =>
  wikiGraph.parse({
    types: [
      {
        id: id(1),
        name: "Test",
        title: "Test",
        body: "Test type",
        category: "node",
        jsonSchema: schema,
      },
      {
        id: id(2),
        name: "Person",
        title: "Person",
        body: "Test type",
        category: "node",
      },
      {
        id: id(3),
        name: "owner",
        title: "owner",
        body: "Test type",
        category: "edge", ontology: { version: 2, endpoints: { from: "any", to: "any" } },
      },
    ],
    nodes: [
      {
        id: id(4),
        typeId: id(1),
        title: "Definition",
        body: JSON.stringify({
          type_id: id(2),
          dependency: {
            name: "accountable owner",
            min_matches: 1,
            path: [
              {
                edge_type_id: id(3),
                direction: "outgoing",
                target_type_ids: [id(2)],
              },
            ],
          },
        }),
      },
      { id: id(5), typeId: id(2), title: "Alex" },
    ],
    edges: [{ id: id(6), typeId: id(3), fromId: id(4), toId: id(5) }],
  });

test("schema-declared paths diagnose missing, archived, reversed and wrong-type connections", () => {
  const graph = fixture(),
    node = graph.nodes[0];
  const unrelated = {
    ...graph,
    types: [...graph.types, {...graph.types[2], id:id(7), name:"unrelated"}],
    edges: graph.edges.map(edge=>({...edge,typeId:id(7)})),
  };
  assert.equal(bodyGraphReferences(unrelated,node,schema).find(check=>check.label==="accountable owner")?.status,"missing");
  assert.ok(
    bodyGraphReferences(graph, node, schema).every(
      (c) => c.status === "resolved",
    ),
  );
  for (const variant of [
    { ...graph, edges: [] },
    { ...graph, edges: graph.edges.map((e) => ({ ...e, archived: true })) },
    {
      ...graph,
      edges: graph.edges.map((e) => ({ ...e, fromId: e.toId, toId: e.fromId })),
    },
    {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === id(5) ? { ...n, typeId: id(1) } : n,
      ),
    },
    {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === id(5) ? { ...n, archived: true } : n,
      ),
    },
  ])
    assert.equal(
      bodyGraphReferences(variant, node, schema).find(
        (c) => c.label === "accountable owner",
      )?.status,
      "missing",
    );
  assert.ok(
    bodyGraphReferences(
      { ...graph, types: graph.types.filter((t) => t.id !== id(2)) },
      node,
      schema,
    ).some((c) => c.status === "missing"),
  );
});

test("shared write validation rejects invalid structured bodies but permits incomplete draft paths", () => {
  const graph = fixture();
  assert.equal(auditOntology(graph).length, 0);
  assert.equal(auditOntology({ ...graph, edges: [] }).length, 0);
  const invalid = {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === id(4) ? { ...n, body: '{"type_id":false}' } : n,
    ),
  };
  assert.ok(auditOntology(invalid).some((e) => e.rule === "body.schema"));
  assert.throws(
    () => requireOntologyValid(graph, invalid, new Map([[id(4), "$control"]])),
    (error) => error instanceof Response && error.status === 400,
  );
});

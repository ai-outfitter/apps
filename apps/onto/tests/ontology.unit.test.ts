import assert from "node:assert/strict";
import test from "node:test";
import { typeInput } from "@ai-outfitter/app-sdk/wiki";
import {
  auditOntology,
  requireOntologyValid,
} from "../src/lib/ontology-validation";
import { readType, storeType } from "../src/lib/type-metadata";

const person = crypto.randomUUID(),
  product = crypto.randomUUID(),
  relation = crypto.randomUUID();
const from = crypto.randomUUID(),
  to = crypto.randomUUID(),
  edge = crypto.randomUUID();
const graph = () => ({
  types: [
    { id: person, category: "node" as const },
    { id: product, category: "node" as const },
    {
      id: relation,
      category: "edge" as const,
      ontology: {
        version: 1 as const,
        endpoints: { from: [person], to: [product] },
      },
    },
  ],
  nodes: [
    { id: from, typeId: person, archived: false },
    { id: to, typeId: product, archived: false },
  ],
  edges: [
    { id: edge, typeId: relation, fromId: from, toId: to, archived: false },
  ],
});

test("ontology metadata coexists with structured bodies and legacy fields round-trip unchanged", () => {
  const base = typeInput.parse({
    category: "edge",
    name: "Uses",
    title: "uses",
    body: "Uses",
  });
  assert.deepEqual(storeType(base).properties, []);
  assert.deepEqual(readType(storeType(base)), base);
  const ontologyOnly = { ...base, ontology: graph().types[2].ontology };
  assert.deepEqual(readType(storeType(ontologyOnly)), ontologyOnly);
  const definition = {
    ...base,
    ontology: graph().types[2].ontology,
    jsonSchema: { type: "object" },
  };
  assert.deepEqual(readType(storeType(definition)), definition);
  assert.deepEqual(
    readType({ properties: { fields: [], jsonSchema: { type: "object" } } }),
    { properties: [], jsonSchema: { type: "object" } },
  );
});

test("unrelated legacy violations remain auditable while edits to affected records are refused", () => {
  const before = graph();
  before.edges[0].fromId = to;
  assert.ok(auditOntology(before).some(error => error.rule === "endpoint.from"));
  requireOntologyValid(
    before,
    before,
    new Map([[crypto.randomUUID(), "$unrelated"]]),
  );
  assert.throws(
    () => requireOntologyValid(before, before, new Map([[to, "$participant"]])),
    (error: unknown) => error instanceof Response && error.status === 400,
  );
  const repaired = graph();
  requireOntologyValid(before, repaired, new Map([[edge, "$repair"]]));
  assert.deepEqual(auditOntology(repaired), []);
});

test("unknown contract versions fail closed and type references never resolve from prose", () => {
  const current = graph();
  current.types[2].ontology = JSON.parse('{"version":99}');
  assert.deepEqual(
    auditOntology(current).map((v) => v.rule),
    ["contract.unsupported", "contract.unsupported"],
  );
  const invalidReference = graph();
  const definition = invalidReference.types[2].ontology;
  assert.ok(definition);
  definition.endpoints.from = [crypto.randomUUID()];
  assert.ok(
    auditOntology(invalidReference).some(
      (v) => v.rule === "contract.endpoint_type",
    ),
  );
});

test("immutable ontology records reject edits, removals and policy downgrades", () => {
  const base = graph();
  const before = { ...base, types: base.types.map(type => type.id === person ? {...type,ontology:{version:2 as const,immutable:true}} : type.id === relation ? {...type,ontology:{version:2 as const,immutable:true,endpoints:{from:[person],to:[product]}}} : type) };
  const roundTrip = readType(storeType(typeInput.parse({ category:"node", name:"Evidence", title:"Evidence", body:"Evidence", ontology: {version:2,immutable:true} })));
  assert.deepEqual("ontology" in roundTrip && roundTrip.ontology, {version:2,immutable:true});
  const conflict = (fn: () => unknown) => assert.throws(fn, (error: unknown) => error instanceof Response && error.status === 409);
  requireOntologyValid(before, {...before, nodes:[...before.nodes, {id:crypto.randomUUID(),typeId:person,archived:false}]});
  conflict(() => requireOntologyValid(before, before, new Map([[from, "$update"]])));
  conflict(() => requireOntologyValid(before, {...before, edges: before.edges.map(row=>({...row,archived:true}))}));
  conflict(() => requireOntologyValid(before, {...before, nodes: before.nodes.filter(row=>row.id!==from)}));
  conflict(() => requireOntologyValid(before, {...before, types:before.types.map(row=>row.id===person?{...row,ontology:undefined}:row)}));
  conflict(() => requireOntologyValid(before, {...before, types:before.types.map(row=>row.id===person?{...row,archived:true}:row)}));
  const legacy = graph();
  conflict(() => requireOntologyValid(legacy, {...legacy, types:legacy.types.map(row=>row.id===person?{...row,ontology:{version:2 as const,immutable:true}}:row)}, new Map([[from,"$rewrite"], [person,"$type"]])));

});

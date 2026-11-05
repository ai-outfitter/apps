import assert from "node:assert/strict";
import test from "node:test";
import type { EntityRecord } from "../src/entities";
import { definitionFromKnowledgeGraph, graphSelectionDefinition, knowledgeGraphSelectInput, selectGraph, selectionResult } from "../src/graph-selection";

const record = (type: string, id: string, attributes: EntityRecord["attributes"]): EntityRecord => ({ ref: { installationId: "wiki", type, id }, revision: 2, title: id, attributes, references: [] });
const types = ["Project", "UseCase", "UserStory", "Product", "Goal", "has_use_case", "has_story", "produces", "pursues", "revision_of", "ProductRevision"].map((name) =>
  record("graph-type", `t-${name}`, { name, category: name[0] === name[0].toUpperCase() ? "node" : "edge" }));
const node = (id: string, type: string, extra: EntityRecord["attributes"] = {}) => record("graph-node", id, { typeId: `t-${type}`, ...extra });
const edge = (id: string, type: string, fromId: string, toId: string) => record("graph-edge", id, { typeId: `t-${type}`, fromId, toId });
const graph = {
  types,
  nodes: [node("p", "Project"), node("u1", "UseCase"), node("u2", "UseCase", { body: JSON.stringify({ status: "retired" }) }), node("s1", "UserStory"), node("prod", "Product"),
    node("g", "Goal"), node("r1", "ProductRevision"), node("other", "Project"), node("s2", "UserStory", { archived: true })],
  edges: [edge("e1", "has_use_case", "p", "u1"), edge("e2", "has_use_case", "p", "u2"), edge("e3", "has_story", "u1", "s1"), edge("e4", "produces", "p", "prod"),
    edge("e5", "pursues", "p", "g"), edge("e6", "revision_of", "r1", "prod"), edge("e7", "produces", "other", "prod"), edge("e8", "has_story", "u1", "missing"), edge("e9", "has_story", "u1", "s2")],
};
const definition = graphSelectionDefinition.parse({
  id: "test", version: 1, rootTypes: ["Project"], maxDepth: 4, maxNodes: 50, terminalTypes: ["Product"],
  relationships: ["has_use_case", "has_story", "produces", { type: "revision_of", direction: "incoming" }],
});

test("selection follows rules and directions, stops at terminal types and hides archived or retired records", () => {
  const selection = selectGraph(graph, ["p"], definition);
  assert.deepEqual(selection.nodes.map((n) => n.ref.id), ["p", "prod", "s1", "u1"]);
  // Product is terminal, so its incoming revision and the other project are not reached; pursues is not a rule.
  assert.ok(!selection.nodes.some((n) => ["r1", "other", "g", "u2", "s2"].includes(n.ref.id)));
  assert.deepEqual(selection.unresolved.map((r) => r.id), ["missing"]);
  assert.equal(selection.depth.get("s1"), 2);
  assert.equal(selection.incomplete, false);
  // Deterministic regardless of input order.
  const shuffled = selectGraph({ ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() }, ["p"], definition);
  assert.deepEqual(selectionResult(graph, shuffled, null), selectionResult(graph, selection, null));
});

test("incoming rules cross edges backwards and budgets report omitted records instead of truncating silently", () => {
  const open = selectGraph(graph, ["p"], { ...definition, terminalTypes: [] });
  assert.ok(open.nodes.some((n) => n.ref.id === "r1"));
  const small = selectGraph(graph, ["p"], { ...definition, maxNodes: 2 });
  assert.equal(small.nodes.length, 2);
  assert.equal(small.incomplete, true);
  assert.ok(small.omitted.length > 0);
  const shallow = selectGraph(graph, ["p"], { ...definition, maxDepth: 1 });
  assert.ok(!shallow.nodes.some((n) => n.ref.id === "s1"));
  assert.ok(shallow.omitted.some((r) => r.id === "s1"));
  assert.equal(selectGraph(graph, ["u1"], definition).roots.length, 0, "roots must match the definition's root types");
});

test("a Wiki KnowledgeGraph record and the action input parse into the shared definition", () => {
  const kg = record("graph-node", "kg", { properties: { root_type: "Project", pattern: JSON.stringify({ relationships: ["has_use_case", { type: "revision_of", direction: "incoming" }], max_depth: 2 }) } });
  const parsed = definitionFromKnowledgeGraph(kg, { id: "wiki:kg", version: 3, maxNodes: 10 });
  assert.equal(parsed.maxDepth, 2);
  assert.deepEqual(parsed.relationships[1], { type: "revision_of", direction: "incoming" });
  assert.equal(knowledgeGraphSelectInput.safeParse({ rootIds: ["00000000-0000-4000-8000-000000000001"] }).success, false, "one definition is required");
  assert.equal(knowledgeGraphSelectInput.safeParse({ definitionId: "00000000-0000-4000-8000-000000000002", definition, rootIds: ["00000000-0000-4000-8000-000000000001"] }).success, false);
});


test("multiple roots are deterministic and cannot bypass the node budget", () => {
  const roots = { ...definition, rootTypes: ["Project", "UseCase"] };
  const first = selectGraph(graph, ["u1", "p", "p"], roots);
  const second = selectGraph(graph, ["p", "u1"], roots);
  assert.deepEqual(selectionResult(graph, first, null), selectionResult(graph, second, null));
  assert.deepEqual(first.roots.map(record => record.ref.id), ["p", "u1"]);
  assert.equal(first.depth.get("u1"), 0);
  assert.throws(() => selectGraph(graph, ["p", "u1"], { ...roots, maxNodes: 1 }), /roots exceed/);
});

test("incoming omitted and unresolved endpoints retain their relationship evidence", () => {
  const incoming = graphSelectionDefinition.parse({ id: "incoming", version: 1, rootTypes: ["Product"],
    maxDepth: 1, maxNodes: 1, relationships: [{ type: "revision_of", direction: "incoming" }] });
  const data = { ...graph, edges: [...graph.edges, edge("missing-incoming", "revision_of", "missing", "prod")] };
  const selection = selectGraph(data, ["prod"], incoming);
  assert.deepEqual(selection.omitted.map(ref => ref.id), ["r1"]);
  assert.deepEqual(selection.unresolved.map(ref => ref.id), ["missing"]);
  assert.deepEqual(selection.edges.map(record => record.ref.id), ["e6", "missing-incoming"]);
});

test("invalid type references fail instead of silently selecting an incomplete view", () => {
  assert.throws(() => selectGraph(graph, ["p"], { ...definition, relationships: ["unknown"] }), /Unknown|supported/);
});

test("mixed valid and missing roots fail rather than silently narrowing selection",()=>{
 assert.throws(()=>selectGraph(graph,["p","missing"],definition),/Every graph root/);
});

test("archived rule types disable their paths as in the saved-lens viewer",()=>{
 const data={...graph,types:graph.types.map(t=>t.attributes.name==="produces"?{...t,attributes:{...t.attributes,archived:true}}:t)};
 const result=selectGraph(data,["p"],definition);
 assert.ok(!result.nodes.some(n=>n.ref.id==="prod"));
 assert.ok(result.nodes.some(n=>n.ref.id==="u1"));
});

test("a saved lens with all relationship types archived retains only its active root",()=>{
 const data={...graph,types:graph.types.map(t=>t.attributes.category==="edge"?{...t,attributes:{...t.attributes,archived:true}}:t)};
 const result=selectGraph(data,["p"],definition);
 assert.deepEqual(result.nodes.map(n=>n.ref.id),["p"]);assert.deepEqual(result.edges,[]);assert.equal(result.incomplete,false);
});

test("partially available lens vocabulary is reported without rejecting usable paths",()=>{
 const result=selectGraph(graph,["p"],{...definition,rootTypes:["Project","FutureType"],relationships:[...definition.relationships,"future_link"]});
 assert.ok(result.nodes.some(n=>n.ref.id==="u1"));
 assert.deepEqual(result.missingTypes,["FutureType","future_link"]);assert.equal(result.incomplete,true);
});

test("edges between selected frontier nodes are retained at the depth limit",()=>{
 const data={...graph,edges:[...graph.edges,edge("frontier-edge","has_story","prod","u1")]};
 const result=selectGraph(data,["p"],{...definition,maxDepth:1,terminalTypes:[]});
 assert.ok(result.edges.some(e=>e.ref.id==="frontier-edge"));
});

test("stop-at types end the walk at reached nodes but never at a root", () => {
  const open = { ...definition, terminalTypes: [] };
  const stopAtRoot = selectGraph(graph, ["p"], { ...open, stopAtTypes: ["Project"] });
  assert.deepEqual(stopAtRoot.nodes.map((n) => n.ref.id), ["p", "prod", "r1", "s1", "u1"]);
  assert.deepEqual(selectGraph(graph, ["p"], { ...open, terminalTypes: ["Project"] }).nodes.map((n) => n.ref.id), ["p"]);
  const stopAtProduct = selectGraph(graph, ["p"], { ...open, stopAtTypes: ["Product"] });
  assert.ok(stopAtProduct.nodes.some((n) => n.ref.id === "prod"));
  assert.ok(!stopAtProduct.nodes.some((n) => n.ref.id === "r1"));
  // A reached stop node keeps no edges to records past it, even unresolved ones.
  assert.ok(selectGraph(graph, ["p"], open).edges.some((e) => e.ref.id === "e8"));
  assert.ok(!selectGraph(graph, ["p"], { ...open, stopAtTypes: ["UseCase"] }).edges.some((e) => e.ref.id === "e8"));
  // Stop after: a reached UseCase expands one more step (its stories); what that step reaches does not expand.
  const stopAfterUseCase = selectGraph(graph, ["p"], { ...open, stopAfterTypes: ["UseCase"] });
  assert.ok(stopAfterUseCase.nodes.some((n) => n.ref.id === "s1"));
  assert.ok(stopAfterUseCase.edges.some((e) => e.ref.id === "e3"));
  const stopAfterProject = selectGraph(graph, ["p"], { ...open, stopAfterTypes: ["Project", "UseCase"] });
  assert.ok(stopAfterProject.nodes.some((n) => n.ref.id === "s1"), "a root of a stop-after type still expands fully");
  const stopAfterProduct = selectGraph(graph, ["p"], { ...open, stopAfterTypes: ["Product"] });
  assert.ok(stopAfterProduct.nodes.some((n) => n.ref.id === "r1"), "a stop-after product shows its revisions");
  // A stop type the Wiki lacks stops nothing and is not a context gap.
  const unknownStop = selectGraph(graph, ["p"], { ...open, stopAtTypes: ["Nope"] });
  assert.deepEqual(unknownStop.missingTypes, selectGraph(graph, ["p"], open).missingTypes);
  assert.equal(unknownStop.incomplete, selectGraph(graph, ["p"], open).incomplete);
});

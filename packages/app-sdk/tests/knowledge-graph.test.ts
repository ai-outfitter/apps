import assert from "node:assert/strict";
import test from "node:test";
import { exploreKnowledgeGraph, loadKnowledgeGraph } from "../src/knowledge-graph";

const types = [{ id: "entity", name: "Entity", category: "node" as const }, { id: "link", name: "link", category: "edge" as const }];
const nodes = ["root", "a", "b"].map(id => ({ id, typeId: "entity" }));
const edges = [
  {id:"b-edge",typeId:"link",fromId:"root",toId:"b"},
  {id:"a-edge",typeId:"link",fromId:"root",toId:"a"},
  {id:"missing-edge",typeId:"link",fromId:"b",toId:"missing"},
  {id:"cycle",typeId:"link",fromId:"a",toId:"root"},
];
const definition = loadKnowledgeGraph({types}, {id:"lens",typeId:"lens-type",body:JSON.stringify({
  name:"Fixture",purpose:"Select connected stored records",rootTypes:["Entity"],
  selection:{relationships:["link"],maxDepth:3,maxNodes:2},
})});

test("shared graph selection is stable under query order and reports bounded omissions", () => {
  const graph={nodes,edges};
  const before=JSON.stringify(graph);
  const selected=exploreKnowledgeGraph(graph,nodes[0],definition);
  const shuffled=exploreKnowledgeGraph({nodes:[...nodes].reverse(),edges:[...edges].reverse()},nodes[0],definition);
  assert.deepEqual(selected,shuffled);
  assert.deepEqual(selected.nodes.map(node=>node.id),["root","a"]);
  assert.deepEqual(selected.omittedIds,["b"]);
  assert.equal(selected.truncated,true);
  assert.equal(JSON.stringify(graph),before);
});

test("selection boundaries block traversal and distinguish excluded from missing references", () => {
  const selected=exploreKnowledgeGraph({nodes,edges},nodes[0],definition,{allowedNodeIds:new Set(["root","b","missing"])});
  assert.deepEqual(selected.nodes.map(node=>node.id),["root","b"]);
  assert.deepEqual(selected.excludedIds,["a"]);
  assert.deepEqual(selected.unresolvedIds,["missing"]);
  assert.equal(selected.truncated,false);
  assert.deepEqual(exploreKnowledgeGraph({nodes,edges},nodes[0],definition,{allowedNodeIds:new Set(["a","b"])}).nodes,[]);
});

test("required paths reserve their budget before broad supporting branches", () => {
  const requiredNodes=["root","org","board","assignment","holder"].map(id=>({id,typeId:"entity"}));
  const goals=Array.from({length:40},(_,i)=>({id:`goal-${i}`,typeId:"entity"}));
  const graph={nodes:[...requiredNodes,...goals],edges:[
    {id:"root-org",typeId:"link",fromId:"root",toId:"org"},
    ...goals.map(node=>({id:`a-${node.id}`,typeId:"link",fromId:"org",toId:node.id})),
    {id:"z-org-board",typeId:"link",fromId:"org",toId:"board"},
    {id:"board-assignment",typeId:"link",fromId:"board",toId:"assignment"},
    {id:"assignment-holder",typeId:"link",fromId:"assignment",toId:"holder"},
  ]};
  const selected=exploreKnowledgeGraph(graph,requiredNodes[0],{...definition,maxDepth:5,maxNodes:6},{priorityNodeIds:new Set(["holder"])});
  for(const node of requiredNodes)assert.ok(selected.nodes.some(row=>row.id===node.id));
  assert.equal(selected.nodes.length,6);
  assert.equal(selected.truncated,true);
  assert.deepEqual(selected.unreachablePriorityIds,[]);
  const unavailable=exploreKnowledgeGraph(graph,requiredNodes[0],{...definition,maxNodes:6},{priorityNodeIds:new Set(["holder"])});
  assert.deepEqual(unavailable.unreachablePriorityIds,["holder"]);
});

test("multiple roots share one budget, depth boundaries report omissions and terminal nodes stop expansion",()=>{
 const graph={nodes,edges};
 const roots=[nodes[2],nodes[0]];
 const selected=exploreKnowledgeGraph(graph,roots,{...definition,maxNodes:3,maxDepth:1});
 assert.deepEqual(selected,exploreKnowledgeGraph(graph,[...roots].reverse(),{...definition,maxNodes:3,maxDepth:1}));
 assert.equal(selected.nodes.length,3);
 assert.equal(selected.depth.get("root"),0);
 const shallow=exploreKnowledgeGraph(graph,nodes[0],{...definition,maxNodes:3,maxDepth:1});
 assert.deepEqual(shallow.unresolvedIds,["missing"]);
 const stopped=exploreKnowledgeGraph(graph,nodes[0],definition,{terminalTypeIds:new Set(["entity"])});
 assert.deepEqual(stopped.nodes,[nodes[0]]);
 assert.deepEqual(stopped.edges,[]);
});

test("all active lens callers hide authored retired records consistently",()=>{
 const retired={id:"old",typeId:"entity",body:JSON.stringify({status:"retired"})};
 const result=exploreKnowledgeGraph({nodes:[...nodes,retired],edges:[...edges,{id:"old-link",typeId:"link",fromId:"root",toId:"old"}]},nodes[0],{...definition,maxNodes:10});
 assert.ok(!result.nodes.some(n=>n.id==="old"));assert.ok(!result.unresolvedIds.includes("old"));
});

test("stop-after leaves do not expand, reserve no budget past them, and lose ties to expanding paths",()=>{
 const stopTypes=[...types,{id:"stop",name:"Stop",category:"node" as const}];
 const stopAfter=loadKnowledgeGraph({types:stopTypes},{id:"lens",typeId:"lens-type",body:JSON.stringify({
  name:"Stops",purpose:"Stop after Stop records",rootTypes:["Entity"],
  selection:{relationships:["link"],maxDepth:5,maxNodes:20,stopAfterTypes:["Stop"]},
 })});
 const graphNodes=[{id:"root",typeId:"entity"},{id:"x",typeId:"stop"},{id:"y",typeId:"entity"},{id:"m",typeId:"entity"},{id:"deep",typeId:"entity"}];
 const link=(id:string,fromId:string,toId:string)=>({id,typeId:"link",fromId,toId});
 // m is reached at depth 2 both through the stop-after record x (sorted first) and through y.
 const tied={nodes:graphNodes,edges:[link("a-root-x","root","x"),link("b-root-y","root","y"),link("c-x-m","x","m"),link("d-y-m","y","m"),link("e-m-deep","m","deep")]};
 const selected=exploreKnowledgeGraph(tied,graphNodes[0],stopAfter);
 assert.ok(selected.nodes.some(node=>node.id==="deep"),"the expanding path through y wins the tie");
 assert.deepEqual(selected.leafIds,[]);
 assert.deepEqual(selected,exploreKnowledgeGraph({nodes:[...graphNodes].reverse(),edges:[...tied.edges].reverse()},graphNodes[0],stopAfter));
 // Without y, m is a leaf: deep is not reached, and a priority record behind it is reported unreachable.
 const onlyStop={nodes:graphNodes,edges:tied.edges.filter(edge=>!edge.id.includes("y"))};
 const leafy=exploreKnowledgeGraph(onlyStop,graphNodes[0],stopAfter,{priorityNodeIds:new Set(["deep"])});
 assert.deepEqual(leafy.leafIds,["m"]);
 assert.ok(!leafy.nodes.some(node=>node.id==="deep"));
 assert.deepEqual(leafy.unreachablePriorityIds,["deep"]);
});

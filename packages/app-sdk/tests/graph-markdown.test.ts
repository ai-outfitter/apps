import assert from "node:assert/strict";
import test from "node:test";
import type { EntityRecord } from "../src/entities";
import { renderGraphMarkdown } from "../src/graph-markdown";
const record = (id: string, attributes: EntityRecord["attributes"] = {}): EntityRecord => ({
  ref: { installationId: "wiki", type: "graph-node", id }, revision: 3, title: id,
  attributes, references: [],
});
test("graph Markdown is deterministic, preserves stored values and does not invent missing ones", () => {
  const first = { record: record("luce", { slug: "luce", body: '{"objectives":["Second","First"],"scope":"Exact\\nmultiline"}' }), group: 0, label: "Agent" };
  const second = { record: record("role", { body: "Authored **Markdown**", website: null }), group: 3, label: "Role" };
  const edge = { record: record("edge", { fromId: "luce", toId: "missing" }), label: "reports to" };
  const input = { nodes: [first, second], edges: [edge] };
  const before = JSON.stringify(input);
  const a = renderGraphMarkdown(input);
  const b = renderGraphMarkdown({ nodes: [second, first], edges: [edge] });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), before);
  assert.ok(a.markdown.includes("Authored **Markdown**"));
  assert.ok(a.markdown.indexOf("Second") < a.markdown.indexOf("First"));
  assert.ok(a.markdown.includes("wiki/graph-node/missing (unresolved)"));
  assert.ok(!a.markdown.includes("Website:"));
  assert.ok(!a.markdown.includes("Responsibilities:"));
  assert.ok(!a.markdown.includes("undefined"));
});
test("document limits omit complete records instead of cutting authored fields", () => {
  const output = renderGraphMarkdown({ nodes: [
    { record: record("root"), group: 0, label: "Agent" },
    { record: record("large", { body: "😀".repeat(20_000) }), group: 7, label: "Artifact" },
  ], edges: [{ record: record("link", { fromId: "root", toId: "large" }), label: "artifact" }] });
  assert.ok(new TextEncoder().encode(output.markdown).length <= 48 * 1024);
  assert.equal(output.complete, false);
  assert.deepEqual(output.omitted.map(ref => ref.id), ["large"]);
  assert.ok(!output.markdown.includes("😀"));
  assert.ok(output.markdown.includes("wiki/graph-node/large (omitted by bounds)"));
  assert.ok(output.sources.some(source => source.ref.id === "large"));
});

test("duplicates, empty values and bounded omissions remain deterministic", () => {
  const node = { record: record("root", { body: '{"explicit_null":null,"values":[null,{},[],"kept"]}' }), group: 0, label: "Agent" };
  const omitted = { installationId: "wiki", type: "graph-node", id: "beyond-bound" };
  const output = renderGraphMarkdown({ nodes: [node, node], edges: [], omitted: [omitted] });
  assert.ok(output.markdown.includes("Explicit null: null"));
  assert.ok(output.markdown.includes("{}"));
  assert.ok(output.markdown.includes("[]"));
  assert.deepEqual(output.omitted, [omitted]);
  assert.equal(output.complete, false);
  assert.throws(() => renderGraphMarkdown({ nodes: [node, { ...node, record: { ...node.record, revision: 4 } }], edges: [] }), /Conflicting/);
});

test("standard Wiki template renders stored type labels and roots with the same factual renderer", async () => {
  const { renderKnowledgeGraphMarkdown } = await import("../src/graph-markdown");
  const root=record("root",{typeId:"agent",body:"Stored **facts**"});
  const child=record("child",{typeId:"role"});
  const type=(id:string,title:string)=>({...record(id,{name:id,title}),ref:{installationId:"wiki",type:"graph-type",id}});
  const input={types:[type("agent","Agent"),type("role","Role")],nodes:[child,root],edges:[],roots:[root.ref]};
  const rendered=renderKnowledgeGraphMarkdown(input);
  assert.ok(rendered.markdown.startsWith("# Agent: root\n"));
  assert.ok(rendered.markdown.includes("## Role: child"));
  assert.ok(rendered.markdown.includes("Stored **facts**"));
  assert.deepEqual(rendered,renderKnowledgeGraphMarkdown({...input,nodes:[root,child],types:[...input.types].reverse()}));
  assert.equal(rendered.sources.length,4);
  assert.equal(rendered.complete,true);
});

test("incoming omitted relationships remain visible in the factual document",()=>{
 const root=record("root");
 const edge={record:record("incoming",{fromId:"outside",toId:"root"}),label:"reports to"};
 const result=renderGraphMarkdown({nodes:[{record:root,group:0,label:"Agent"}],edges:[edge],omitted:[{...root.ref,id:"outside"}]});
 assert.ok(result.markdown.includes("reports to (incoming): wiki/graph-node/outside (omitted by bounds)"));
 assert.ok(result.sources.some(source=>source.ref.id==="incoming"));
});

test("relationship properties and authored body survive the standard template",()=>{
 const root=record("root");const child=record("child");
 const edge={record:record("edge",{fromId:"root",toId:"child",properties:{scope:"Only this project"},validity:{from:"2026-01-01",to:null},body:"Authored **relationship**"}),label:"relates"};
 const output=renderGraphMarkdown({nodes:[{record:root,group:0,label:"Root"},{record:child,group:1,label:"Child"}],edges:[edge]});
 assert.ok(output.markdown.includes("Only this project"));assert.ok(output.markdown.includes("2026-01-01"));assert.ok(output.markdown.includes("Authored **relationship**"));
});

test("missing incoming endpoints invalidate completeness without caller-supplied metadata",()=>{
 const root=record("root");
 const result=renderGraphMarkdown({nodes:[{record:root,group:0,label:"Root"}],edges:[{record:record("edge",{fromId:"missing",toId:"root"}),label:"related"}]});
 assert.equal(result.complete,false);assert.deepEqual(result.unresolved,[{...root.ref,id:"missing"}]);
});

test("relationships between included records render once rather than consuming the budget twice",()=>{
 const root=record("root"), child=record("child");const rel=record("edge",{fromId:"root",toId:"child",body:"x".repeat(1200)});
 const result=renderGraphMarkdown({nodes:[{record:root,group:0,label:"Root"},{record:child,group:1,label:"Child"}],edges:[{record:rel,label:"related"}],maxBytes:2500});
 assert.equal(result.complete,true);assert.equal(result.markdown.split("Relationship: wiki/graph-node/edge").length-1,1);
 assert.ok(Buffer.byteLength(result.markdown)<=2500);
});

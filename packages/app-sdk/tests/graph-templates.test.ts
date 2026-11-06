import assert from "node:assert/strict";
import test from "node:test";
import type { EntityRecord } from "../src/entities";
import { renderGraphTemplates } from "../src/graph-templates";

const record = (id: string, attributes: EntityRecord["attributes"] = {}): EntityRecord => ({ref:{installationId:"wiki",type:"graph-node",id},revision:1,title:id,attributes,references:[]});
const template = (id: string, order: number, sections: unknown[]) => ({record:record(id),definition:{version:1,name:id,order,bindings:{root:{op:"ref",id:"$params.rootId"}},sections}});
const node = record("resident",{typeId:"agent",summary:"Stored **text**\nsecond line",body:'{"values":["Second","First"]}'});
const type = {...record("agent",{name:"Agent"}),ref:{installationId:"wiki",type:"graph-type",id:"agent"}};
const section = {heading:"$root.title",level:1,fields:[{label:"Description",value:"$root.summary"},{label:"Values",value:"$root.data.values"},{label:"Missing",value:"$root.absent"}]};
const render = (templates = [template("identity",0,[section])],nodes = [node]) => renderGraphTemplates({installationId:"wiki",types:[type],nodes,edges:[],templates,parameters:{rootId:"resident"}});
test("stored templates compose deterministically, preserve authored values and keep metadata out of Markdown", () => {
  const templates=[template("later",10,[{heading:"Later"}]),template("identity",0,[section])];
  const a=render(templates),b=render([...templates].reverse());
  assert.deepEqual(a,b);
  assert.ok(a.markdown.startsWith("# resident"));
  assert.ok(a.markdown.includes("Stored **text**\n  second line"));
  assert.ok(a.markdown.indexOf("Second")<a.markdown.indexOf("First"));
  assert.ok(!a.markdown.includes("Missing:"));
  assert.ok(!a.markdown.includes("Reference:"));
  assert.ok(a.sources.some(source=>source.ref.id==="identity"));
  const revised=render([{...templates[0],record:{...templates[0].record,revision:2}},templates[1]]);
  assert.notDeepEqual(revised.sources,a.sources);
});
test("a template-only edit changes the real renderer output",()=>{
  const updated=template("identity",0,[{...section,fields:[]}]);
  assert.ok(!render([updated]).markdown.includes("Stored **text**"));
  assert.ok(render().markdown.includes("Stored **text**"));
});
test("templates cannot resolve records beyond the provided graph or inherited object properties",()=>{
  const t=template("scoped",0,[{heading:"Selected",fields:[{label:"Secret",value:"$other.body"},{label:"Prototype",value:"$root.constructor"}]}]);
  Object.assign(t.definition.bindings,{other:{op:"ref",id:"foreign"}});
  const result=render([t]);
  assert.ok(!result.markdown.includes("Secret:"));
  assert.ok(!result.markdown.includes("Prototype:"));
  assert.equal(result.complete,false);
  assert.deepEqual(result.unresolved.map(ref=>ref.id),["foreign"]);
});
test("oversized output and recursive expressions fail explicitly without cutting authored text",()=>{
  assert.throws(()=>render(undefined,[{...node,attributes:{...node.attributes,summary:"x".repeat(50*1024)}}]),error=>error instanceof Response && error.status===413);
  let expr: unknown="$root.title";
  for(let i=0;i<30;i++)expr={op:"concat",parts:[expr]};
  assert.throws(()=>render([template("deep",0,[{heading:expr}])]),error=>error instanceof Response && error.status===413);
});

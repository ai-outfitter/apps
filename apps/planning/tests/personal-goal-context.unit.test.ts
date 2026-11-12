import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildSchema, parse, validate } from "graphql";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { capturePersonalGoalContext, personalGoalQuery } from "../src/server/personal-goal-context";

const actor: AppIdentity = { userId: "alice", owner: {kind:"user",id:"alice"}, installationId:"planning", role:"owner",canEdit:true };
const node = (id:string,title:string) => ({id,revision:2,title,body:"Recorded definition",properties:{} as Record<string,unknown>,archived:false,updatedAt:"2026-11-10T12:00:00Z"});
function sourceData() {
 const metric={...node("metric","Weekly activity definition"),__typename:"MetricDefinition",properties:{calculation:"Recorded method",unit:"hours",source:"Reviewed diary",interval:"weekly"}};
 const goal={...node("goal","Personal activity goal"),metrics:[{id:"edge",revision:3,fromId:"goal",toId:"metric",body:null,properties:{},archived:false,to:metric}]};
 return {goals:{nodes:[goal],pageInfo:{hasNextPage:false,endCursor:null}}};
}
function fixture(transform:(data:ReturnType<typeof sourceData>)=>unknown=data=>({data})) {
 const calls:{operation:string;input:Record<string,unknown>}[]=[];
 const host={async call(operation:string,input:Record<string,unknown>){
  calls.push({operation,input});
  if(operation==="entities.types") return input.template==="wiki-map"?[]:["graph-type","graph-node","graph-edge"].map(type=>({type,installationId:"personal-onto",template:"onto",writable:true}));
  assert.equal(operation,"actions.call");assert.equal(input.installationId,"personal-onto");assert.equal(input.action,"graph.graphql");assert.equal(input.readOnly,true);
  return transform(sourceData());
 }} as unknown as WorkflowHost<"interactive">;
 return {host,calls};
}
test("the personal goal query uses the existing typed graph contract",async()=>{
 const schema=buildSchema(await readFile(new URL("../../../packages/app-sdk/graph/standard-schema.graphql",import.meta.url),"utf8"));
 assert.deepEqual(validate(schema,parse(personalGoalQuery)),[]);
 // Owner-authored legacy MetricDefinition records need not declare today's
 // optional standard properties as typed GraphQL fields. Generic properties
 // preserves their definitions without requiring an ontology rewrite.
 const restoredSchema=buildSchema((await readFile(new URL("../../../packages/app-sdk/graph/standard-schema.graphql",import.meta.url),"utf8"))
   .replace(/type MetricDefinition[^]*?\n}/,block=>block.replace(/^  (calculation|unit|source|interval):[^\n]*\n/gm,"")));
 assert.deepEqual(validate(restoredSchema,parse(personalGoalQuery)),[]);
});
test("personal goal context pins goal, metric and relationship revisions without inventing observations or standup",async()=>{
 const f=fixture(),captured=await capturePersonalGoalContext(f.host,actor,123);
 assert.equal(captured.complete,true);assert.equal(captured.capturedAt,123);assert.deepEqual(captured.errors,[]);
 assert.equal(captured.goals[0].ref.id,"goal");assert.equal(captured.goals[0].ref.revision,2);
 assert.equal(captured.goals[0].metrics[0].relationship.revision,3);
 assert.equal(captured.goals[0].metrics[0].properties?.unit,"hours");assert.equal(captured.goals[0].metrics[0].observation.value,null);
 assert.equal(captured.goals[0].observation.status,"unknown");assert.equal(captured.standup.status,"unavailable");
 assert.deepEqual(captured.references.map(ref=>[ref.type,ref.id,ref.revision]),[["graph-edge","edge",3],["graph-node","goal",2],["graph-node","metric",2]]);
 assert.equal(captured.completeness.history,"current-records-only");assert.ok(captured.source?.digest);
 assert.ok(!f.calls.some(call=>call.operation==="inference.generate"||call.operation==="platform.document"));
});
test("empty goals are an observed empty set, while absent, truncated and failed sources stay unknown",async()=>{
 const empty=await capturePersonalGoalContext(fixture(()=>({data:{goals:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}})).host,actor);
 assert.equal(empty.complete,true);assert.deepEqual(empty.goals,[]);assert.equal(empty.standup.status,"unavailable");
 for(const transform of [()=>({data:null}),()=>({data:sourceData(),extensions:{truncated:true}}),()=>({data:null,errors:[{message:"Source unavailable"}]})]){
  const captured=await capturePersonalGoalContext(fixture(transform).host,actor);assert.equal(captured.complete,false);assert.ok(captured.errors.length);assert.equal(captured.source,null);
 }
 const partial=await capturePersonalGoalContext(fixture(data=>({data:{goals:{...data.goals,pageInfo:{hasNextPage:true,endCursor:"next"}}}})).host,actor);
 assert.equal(partial.complete,false);assert.equal(partial.goals.length,1);assert.match(partial.errors.join(" "),/incomplete/);
});
test("retired records are excluded and invalid metric relationships or changing revisions refuse complete coverage",async()=>{
 const retired=await capturePersonalGoalContext(fixture(data=>{data.goals.nodes[0].body='{"status":"retired"}';return {data};}).host,actor);
 assert.equal(retired.complete,true);assert.deepEqual(retired.goals,[]);
 const invalid=await capturePersonalGoalContext(fixture(data=>{data.goals.nodes[0].metrics[0].to.__typename="Person";return {data};}).host,actor);
 assert.equal(invalid.complete,false);assert.deepEqual(invalid.goals[0].metrics,[]);
 const changed=await capturePersonalGoalContext(fixture(data=>{
  const another=structuredClone(data.goals.nodes[0]);another.id="other-goal";another.metrics[0].fromId="other-goal";another.metrics[0].to.revision=4;data.goals.nodes.push(another);return {data};
 }).host,actor);
 assert.equal(changed.complete,false);assert.match(changed.errors.join(" "),/revisions disagree/);
});
test("organization scope is refused before reading any personal goal source",async()=>{
 const f=fixture();await assert.rejects(capturePersonalGoalContext(f.host,{...actor,owner:{kind:"organization",id:"org"},organizationId:"org"}),error=>error instanceof Response&&error.status===403);
 assert.deepEqual(f.calls,[]);
});

test("definition targets and number-shaped content remain source data rather than fabricated measured progress",async()=>{
 const captured=await capturePersonalGoalContext(fixture(data=>{
  data.goals.nodes[0].properties={target:100};
  data.goals.nodes[0].metrics[0].to.body='{"kind":"planning-kpi","value":12}';
  return {data};
 }).host,actor);
 assert.equal(captured.complete,true);
 assert.match(captured.goals[0].metrics[0].body ?? "",/"value":12/);
 assert.equal(captured.goals[0].metrics[0].observation.value,null);
 assert.equal(captured.completeness.metricObservations,"unknown");
});

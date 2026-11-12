import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {reconcileLocalSnapshot} from "../scripts/local-seed";
import {storeType} from "../src/lib/type-metadata";
import {core} from "../src/lib/graph";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const type=(typeId:string,category:"node"|"edge",name:string)=>({id:typeId,category,name,title:name,body:"Authored fixture definition",properties:[],archived:false,revision:7,createdAt:1,updatedAt:2,createdBy:"fixture-author",updatedBy:"fixture-author"});
const graph={types:[type(core.person,"node","Person"),type(core.project,"node","Project"),type("71000000-0000-4000-8000-000000000023","edge","reports_to")],nodes:[{id:id(1),typeId:core.person,slug:"fixture-person",title:"Fixture person",properties:{}},{id:id(2),typeId:core.project,slug:"fixture-project",title:"Fixture project",properties:{}}],edges:[{id:id(3),typeId:"71000000-0000-4000-8000-000000000023",fromId:id(1),toId:id(2),properties:{}}]};
function baseline(){const db=new DatabaseSync(":memory:");db.exec(readFileSync(new URL("../migrations/0000_onto.sql",import.meta.url),"utf8"));return db;}
function insert(db:DatabaseSync,data:typeof graph|ReturnType<typeof reconcileLocalSnapshot>["graph"]){
 for(const row of data.types)db.prepare("INSERT INTO graph_types(id,category,name,title,body,properties,createdAt,updatedAt) VALUES(?,?,?,?,?,?,1,2)").run(row.id,row.category,row.name,row.title,row.body,JSON.stringify(storeType(row).properties));
 for(const row of data.nodes)db.prepare("INSERT INTO graph_nodes(id,typeId,slug,title,createdAt,updatedAt) VALUES(?,?,?,?,1,2)").run(row.id,row.typeId,row.slug,row.title);
 for(const row of data.edges)db.prepare("INSERT INTO graph_edges(id,typeId,fromId,toId,createdAt,updatedAt) VALUES(?,?,?,?,1,2)").run(row.id,row.typeId,row.fromId,row.toId);
}

test("legacy endpoints reconcile before baseline triggers while preserving authored identity and prior revision",()=>{
 const before=JSON.stringify(graph),db=baseline();
 try{assert.throws(()=>insert(db,graph),/endpoint types not allowed/);}finally{db.close();}
 const result=reconcileLocalSnapshot(graph);
 assert.equal(JSON.stringify(graph),before,"source data remains untouched");
 assert.deepEqual(result.graph.types.map(row=>row.id),graph.types.map(row=>row.id));
 const changed=result.graph.types.find(row=>row.id==="71000000-0000-4000-8000-000000000023")!;
 assert.equal(changed.body,"Authored fixture definition");
 assert.equal(changed.revision,8);
 assert.deepEqual(changed.ontology?.endpoints,{from:"any",to:"any"},"canonical migration preserves relationships accepted by unconstrained legacy semantics");
 assert.equal(result.revisions.length,1);
 assert.equal(JSON.parse(result.revisions[0].prior).revision,7);
 assert.equal(JSON.parse(result.revisions[0].snapshot).revision,8);
 assert.match(JSON.parse(result.revisions[0].approval).reason,/would reject/);
 const target=baseline();
 try{insert(target,result.graph);assert.equal(target.prepare("SELECT count(*) AS count FROM graph_edges").get()?.count,1);}finally{target.close();}
});

test("an explicit incompatible endpoint contract fails rather than weakening or dropping the relationship",()=>{
 const explicit={...graph,types:graph.types.map(row=>row.category==="edge"?{...row,ontology:{version:2,endpoints:{from:[core.person],to:[core.person]}}}:row)};
 assert.throws(()=>reconcileLocalSnapshot(explicit),/endpoint types disallowed by reports_to/);
});

test("personal omission repair is exact, scoped and leaves an already repaired contract unchanged", () => {
 const commitment="86cd3b21-71e2-5dfa-9bd0-000000000003",subject="86cd3b21-71e2-5dfa-9bd0-000000000015";
 const known={types:[type(commitment,"node","ControlCommitment"),type(core.person,"node","Person"),{...type(subject,"edge","commitment_subject"),ontology:{version:2,endpoints:{from:[commitment],to:["86cd3b21-71e2-5dfa-9bd0-000000000001",core.organization,core.product]}}}],nodes:[{...graph.nodes[0],typeId:commitment},{...graph.nodes[1],typeId:core.person}],edges:[{...graph.edges[0],typeId:subject}]};
 assert.throws(()=>reconcileLocalSnapshot(known),/endpoint types disallowed/);
 const repaired=reconcileLocalSnapshot(known,true);
 assert.equal(repaired.revisions.length,1);
 assert.equal(reconcileLocalSnapshot(repaired.graph,true).revisions.length,0);
 const authored=structuredClone(known);assert.ok("ontology" in authored.types[2]);authored.types[2].ontology.endpoints.to=[core.organization];
 assert.throws(()=>reconcileLocalSnapshot(authored,true),/endpoint types disallowed/);
});

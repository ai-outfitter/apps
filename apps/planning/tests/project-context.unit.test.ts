import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveGraphql } from "@ai-outfitter/app-sdk/app-graphql";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { queryGraph } from "@ai-outfitter/app-sdk/graph-query";
import { wikiGraphRecords } from "@ai-outfitter/app-sdk/graph-client";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { projectContextRecords } from "../src/project-readiness";
import { documents } from "../src/server/documents";
import { graphqlSchema } from "../src/server/graphql";

function snapshot() {
 const relations=["has_use_case","has_story","addresses","experiences","produces"];
 const types=["Project","UseCase","UserStory","CustomerSegment","Problem","Product",...relations].map(name=>({id:name,name,category:relations.includes(name)?"edge" as const:"node" as const,revision:1}));
 const node=(id:string,typeId:string,extra:Record<string,any>={})=>({id,typeId,title:id,summary:`Summary of ${id}`,revision:1,...extra});
 const source=(installationId:string,id:string)=>({source:{installationId,type:"project",id}});
 const nodes=[node("anchor-a","Project",{...source("planning","a"),slug:"stored-project-slug"}),node("anchor-b","Project",source("planning","b")),
  node("case","UseCase"),node("story","UserStory"),node("other-story","UserStory"),node("segment","CustomerSegment"),node("problem","Problem"),node("shared-product","Product"),
  node("authored-case","UseCase",{properties:{planning_installation_id:"planning",project_id:"a"}}),
  node("foreign-case","UseCase",{properties:{planning_installation_id:"other-planning",project_id:"a"}}),
  node("archived-case","UseCase",{archived:true,properties:{planning_installation_id:"planning",project_id:"a"}})];
 const edge=(fromId:string,typeId:string,toId:string)=>({...node(`${fromId}-${typeId}-${toId}`,typeId),fromId,toId});
 const edges=[edge("anchor-a","has_use_case","case"),edge("anchor-a","has_story","story"),edge("anchor-a","addresses","problem"),edge("segment","experiences","problem"),
  edge("anchor-a","produces","shared-product"),edge("anchor-b","produces","shared-product"),edge("anchor-b","has_story","other-story")];
 return {version:1 as const,installationId:"wiki",types,nodes,edges,selection:null,truncated:false,missingTypes:[]};
}

test("project associations use exact references/properties, exclude archived and foreign records, and stop at shared context",()=>{
 const graph=wikiGraphRecords(snapshot());
 const selected=projectContextRecords(graph,"planning","a");
 assert.deepEqual(selected.useCases.map(row=>row.id),["authored-case","case"]);
 assert.deepEqual(selected.userStoryRecords.map(row=>row.id),["story"]);
 assert.deepEqual(selected.customerSegments.map(row=>row.id),["segment"]);
 assert.deepEqual(projectContextRecords(graph,"other-planning","a").useCases.map(row=>row.id),["foreign-case"]);
 assert.deepEqual(projectContextRecords(graph,"planning","unlinked"),{useCases:[],customerSegments:[],userStoryRecords:[], goalRecords: [] });
 const duplicate=structuredClone(graph.nodes[0]);duplicate.ref.id="duplicate-anchor";graph.nodes.push(duplicate);
 assert.throws(()=>projectContextRecords(graph,"planning","a"),error=>error instanceof Response && error.status===409);
});

test("Projects resolves all nested lists from one scoped Wiki read per execution and preserves legacy Markdown",async()=>{
 const client=createClient({url:":memory:"});
 try {
  const db=drizzle(client);
  await migrate(db,{migrationsFolder:fileURLToPath(new URL("../migrations",import.meta.url))});
  await client.executeMultiple(`INSERT INTO planning_projects(id,installationId,name,userStories,createdBy,updatedBy,createdAt,updatedAt) VALUES
   ('a','planning','A','Legacy Markdown','seed','seed',1,1),('b','planning','B','','seed','seed',1,1),('foreign','other-planning','Foreign','','seed','seed',1,1);`);
  // The Wiki answers graph.query with the SDK's own engine over its snapshot (the same code the
  // Wiki runs); a Wiki without the source and property filters answers 400 and Planning reads the whole graph.
  let graphReads=0;
  const legacyWiki=process.env.PLANNING_TEST_LEGACY_WIKI==="1";
  const host={call:async(name:string,input:any)=>{
   if(name==="entities.types")return ["graph-type","graph-node","graph-edge"].map(type=>({installationId:"wiki",type,writable:false}));
   assert.equal(name,"actions.call");assert.equal(input.installationId,"wiki");
   if(input.action==="graph.query"){
    if(legacyWiki)throw new Response("Invalid input",{status:400});
    graphReads++;
    return queryGraph(snapshot() as never,input.input);
   }
   assert.equal(input.action,"graph.read");assert.ok(legacyWiki,"graph.read only when graph.query lacks the filters");
   graphReads++;return snapshot();
  }};
  const context=()=>({db:()=>db,identity:{installationId:"planning"},host:()=>host});
  const native=await serveGraphql({schema:graphqlSchema,query:"{projects {nodes{id userStories} pageInfo{hasNextPage}}}",context:context()});
  assert.equal(native.errors,undefined);assert.equal((native.data as any).projects.nodes[0].userStories,"Legacy Markdown");assert.equal(graphReads,0);
  for(let execution=0;execution<2;execution++){
   const result=await serveGraphql({schema:graphqlSchema,query:documentText(documents.Projects.document),context:context()});
   assert.equal(result.errors,undefined,JSON.stringify(result.errors));
   const rows=(result.data as any).projects.nodes;
   assert.deepEqual(rows.map((row:any)=>row.id),["a","b"]);
   assert.deepEqual(rows[0].userStories.map((row:any)=>row.id),["story"]);
   assert.deepEqual(rows[0].customerSegments.map((row:any)=>row.id),["segment"]);
   // One subgraph read per execution: the projects' context, then the context around the products it reached.
   assert.equal(graphReads,(execution+1)*(legacyWiki?1:2));
  }
  const summaries=await serveGraphql({schema:graphqlSchema,query:documentText(documents.ProjectSummaries.document),context:context()});
  assert.equal(summaries.errors,undefined,JSON.stringify(summaries.errors));
  const summaryRows=(summaries.data as any).projectSummaries.nodes;
  assert.equal(summaryRows[0].slug,"stored-project-slug");
  assert.equal(summaryRows[1].slug,null);
  assert.equal(graphReads,legacyWiki?3:6);
 }finally{client.close();}
});


test("project state changes are revision checked, scoped, filterable and reversible", async () => {
 const client=createClient({url:":memory:"});
 try {
  const db=drizzle(client);
  await migrate(db,{migrationsFolder:fileURLToPath(new URL("../migrations",import.meta.url))});
  const id="11111111-1111-4111-8111-111111111111";
  await client.execute({sql:"INSERT INTO planning_projects(id,installationId,name,createdBy,updatedBy,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)",args:[id,"planning","Test","seed","seed",1,1]});
  const {setProjectState}=await import("../src/server/planning");
  const identity={installationId:"planning",userId:"user"} as any;
  const draft=await setProjectState(db,identity,{project:{id,revision:1},state:"draft"});
  assert.equal(draft.state,"draft");
  await assert.rejects(setProjectState(db,identity,{project:{id,revision:1},state:"active"}),(e:unknown)=>e instanceof Response && e.status===409);
  await assert.rejects(setProjectState(db,{...identity,installationId:"other"},{project:{id,revision:2},state:"active"}),(e:unknown)=>e instanceof Response && e.status===409);
  const context={db:()=>db,identity,host:()=>({})};
  const read=async(query:string)=>serveGraphql({schema:graphqlSchema,query,context});
  const filtered=await read('{projects(states:["draft"]){nodes{id state}}}');
  assert.deepEqual((filtered.data as any).projects.nodes.map((n:any)=>n.id),[id]);
  await setProjectState(db,identity,{project:{id,revision:2},state:"archived"});
  const hidden=await read('{projects{nodes{id}}}');
  assert.equal((hidden.data as any).projects.nodes.length,0);
  const archived=await read('{projects(states:["archived"]){nodes{id state}}}');
  assert.equal((archived.data as any).projects.nodes[0].state,"archived");
  const restored=await setProjectState(db,identity,{project:{id,revision:3},state:"backlog"});
  assert.equal(restored.archived,false);
 } finally { client.close(); }
});

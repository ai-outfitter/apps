import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { parse, print } from "graphql";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { discoveryRecords } from "../src/server/schema";
import { DISCOVERY_PREVIEW_VERSION } from "../src/discovery-version";
import { createPlanningIntake, planningCandidates, planningCreateIntakeDocument, planningIntakeInput } from "../src/server/planning-intake";
import type { Preview } from "../src/server/discovery";

const who: AppIdentity = { installationId: "forerunner", userId: "alice", owner: { kind: "user", id: "alice" }, role: "owner", canEdit: true };
const nodeId = "10000000-0000-4000-8000-000000000001", correctedId = "10000000-0000-4000-8000-000000000002";
const status = (code: number) => (error: unknown) => error instanceof Response && error.status === code;
async function fixture(invokePlanning?: (input: any) => Promise<unknown>) {
  const client = createClient({url:":memory:"}), db = drizzle(client);
  await migrate(db,{migrationsFolder:fileURLToPath(new URL("../migrations",import.meta.url))});
  const preview: Preview = { id:crypto.randomUUID(),version:DISCOVERY_PREVIEW_VERSION,createdAt:new Date().toISOString(),savedAt:new Date().toISOString(),
    destination:"personal",wikiInstallationId:"wiki",wikiSlug:"wiki",systemPrompt:"",warnings:[],sources:[
      {label:"gmail · personal@example.test",count:1,method:"agent-import",window:"7d"},
      {label:"gmail · other@example.test",count:1,method:"agent-import",window:"7d"},
    ],entries:[{id:nodeId,typeId:"problem-type",title:"Private inferred title",kind:"Problem",existing:true,excerpt:"PRIVATE EMAIL TEXT MUST STAY PRIVATE"}],
    operations:[],receipt:{state:"committed"},evaluations:[] };
  const save = async () => { await db.delete(discoveryRecords);await db.insert(discoveryRecords).values({id:preview.id,installationId:who.installationId,ownerId:who.userId,kind:"preview",data:JSON.stringify(preview),createdAt:Date.now()}); };
  await save();
  const calls: {name:string;input:any}[]=[]; const captured = new Map<string,unknown>();
  let allowed=true,revision=2,available=true,refuse=false;
  const host = {call:async(name:string,input:any)=>{
    calls.push({name,input});
    if(name==="entities.get") {
      if(!available)throw new Response("Not found",{status:404});
      return {ref:{installationId:"wiki",type:"graph-node",id:input.id},revision,title:"Reviewed booking problem",attributes:{typeId:"problem-type",summary:"A saved problem",body:"A confirmed traveler need",archived:false},references:[]};
    }
    if(name==="actions.list")return allowed?[{installationId:"planning",actions:[{name:"graph.mutate",permitted:true},{name:"graph.graphql",permitted:true}]}]:[];
    if(name==="actions.call"){
      if(input.action==="graph.graphql")return {data:{projects:{nodes:[{id:"project",name:"Personal booking project",revision:1}],pageInfo:{endCursor:null,hasNextPage:false}}}};
      if(invokePlanning)return invokePlanning(input);
      if(refuse)return {data:null,errors:[{message:"Editors only",extensions:{status:403}}]};
      const value=input.input.variables.input;
      if(!captured.has(value.requestId))captured.set(value.requestId,{id:value.requestId,revision:1,title:value.title});
      return {data:{createIntake:captured.get(value.requestId)}};
    }
    throw Error(`Unexpected ${name}`);
  }} as unknown as WorkflowHost<"interactive">;
  const input = () => planningIntakeInput.parse({previewId:preview.id,entryIndex:0,expectedId:nodeId,expectedRevision:revision,planningInstallationId:"planning",confirmDestination:true});
  return {client,db,preview,save,host,calls,captured,input,setAllowed:(value:boolean)=>allowed=value,setAvailable:(value:boolean)=>available=value,setRevision:(value:number)=>revision=value,setRefuse:()=>refuse=true};
}
test("the bridge calls exactly Planning's existing published intake mutation",async()=>{
  const published=JSON.parse(await readFile(new URL("../../planning/graph/documents.json",import.meta.url),"utf8"));
  assert.equal(print(parse(planningCreateIntakeDocument)),published.find((row:any)=>row.name==="CreateIntake").query);
});
test("selected multi-account discovery creates one scoped intake, retaining canonical source without private mail",async()=>{
  const f=await fixture();try{
    const candidates=await planningCandidates(f.db,who,f.host,{previewId:f.preview.id});
    assert.deepEqual(candidates.items[0],{entryIndex:0,expectedId:nodeId,expectedRevision:2,title:"Reviewed booking problem",kind:"Problem"});
    assert.ok(!JSON.stringify(candidates).includes("personal@example.test"));
    assert.equal(candidates.destinations[0].projects?.nodes[0].name,"Personal booking project");
    const first=await createPlanningIntake(f.db,who,f.host,f.input());
    assert.deepEqual(await createPlanningIntake(f.db,who,f.host,f.input()),first);
    // The same canonical need in a later shared scan does not duplicate intake.
    f.preview.id=crypto.randomUUID();await f.save();
    assert.equal((await createPlanningIntake(f.db,who,f.host,f.input())).requestId,first.requestId);
    assert.equal(f.captured.size,1);
    const write=f.calls.find(call=>call.name==="actions.call" && call.input.action==="graph.mutate")!.input;
    assert.equal(write.action,"graph.mutate");assert.equal(write.input.operationName,"CreateIntake");
    assert.deepEqual(write.input.variables.input.sources,[{installationId:"wiki",type:"graph-node",id:nodeId,revision:2}]);
    assert.ok(!JSON.stringify(write).includes("PRIVATE EMAIL"));assert.ok(!JSON.stringify(write).includes("@example.test"));
    assert.equal(f.calls.filter(call=>call.name==="platform.document").length,0);
  }finally{f.client.close();}
});
test("corrected matches and current revisions govern capture; private or unreviewed findings cannot cross owner scopes",async()=>{
  const f=await fixture();try{
    f.preview.entries[0].matchedId=correctedId;await f.save();
    await assert.rejects(createPlanningIntake(f.db,who,f.host,f.input()),status(409));
    const corrected={...f.input(),expectedId:correctedId};
    const saved=await createPlanningIntake(f.db,who,f.host,corrected);assert.equal(saved.source.id,correctedId);
    f.setRevision(3);await assert.rejects(createPlanningIntake(f.db,who,f.host,corrected),status(409));
    f.setRevision(2);f.setAllowed(false);await assert.rejects(createPlanningIntake(f.db,who,f.host,corrected),status(403));
    await assert.rejects(createPlanningIntake(f.db,{...who,userId:"other"},f.host,corrected),status(404));
    delete f.preview.savedAt;await f.save();await assert.rejects(createPlanningIntake(f.db,who,f.host,corrected),status(409));
    assert.equal(f.captured.size,1);
  }finally{f.client.close();}
});
test("pending canonical records, missing confirmation and downstream authority refusal fail closed",async()=>{
  const f=await fixture();try{
    assert.equal(planningIntakeInput.safeParse({...f.input(),confirmDestination:false}).success,false);
    f.setAvailable(false);await assert.rejects(createPlanningIntake(f.db,who,f.host,f.input()),status(404));assert.equal(f.captured.size,0);
    f.setAvailable(true);f.setRefuse();await assert.rejects(createPlanningIntake(f.db,who,f.host,f.input()),status(403));assert.equal(f.captured.size,0);
  }finally{f.client.close();}
});


test("the bridge persists a real personal Planning intake and retries without creating another request",async()=>{
  const app=await appWorker("planning",appArtifact(new URL("../../planning",import.meta.url),"operational"),"planning",{workflowHost:()=>({
    call:async(operation)=> operation==="entities.get"?{ok:true,value:{ref:{installationId:"wiki",type:"graph-node",id:nodeId},revision:2,title:"Reviewed booking problem",attributes:{body:"Saved need"},references:[]}}:{ok:false,status:503,message:"Routing unavailable in fixture"},
  })});
  const actor={userId:"alice",organizationId:"",role:"owner",owner:{kind:"user" as const,id:"alice"}};
  const scope={installationId:app.installationId,userId:"alice",organizationId:null,packageHash:"fixture",phase:"interactive" as const,expiresAt:Date.now()+60000};
  const f=await fixture(async input=>{
    const response=await app.call("/api/internal/actions/v1/call",actor,{method:"POST",workflowHost:scope,body:{action:input.action,input:input.input}});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  });
  try{
    const saved=await createPlanningIntake(f.db,who,f.host,f.input());
    assert.equal((saved.intake as any).id,saved.requestId);
    assert.equal((saved.intake as any).routingError,"Routing unavailable in fixture");
    const replay=await createPlanningIntake(f.db,who,f.host,f.input());
    assert.equal((replay.intake as any).id,saved.requestId);
    const response=await app.call("/api/internal/actions/v1/call",actor,{method:"POST",workflowHost:scope,body:{action:"graph.graphql",input:{query:"query {intakes { nodes {id title} }}"}}});
    const read=await response.json() as any;
    assert.equal(read.data.intakes.nodes.length,1);
    assert.equal(read.data.intakes.nodes[0].title,"Reviewed booking problem");
  }finally{f.client.close();await app.dispose();}
});

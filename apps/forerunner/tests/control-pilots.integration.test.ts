import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { identityHeaderValues } from "@ai-outfitter/app-sdk/server";
import { mergePilot, personalControlPilot, organizationControlPilot, pilotId, personTypeId } from "../scripts/control-pilots";

test("personal and organization control pilots are complete, separate and repeatable", async t => {
  const artifact = appArtifact(new URL("../../onto/", import.meta.url), "operational");
  const personal = await appWorker("wiki-map", artifact, "personal-pilot");
  const org = await appWorker("wiki-map", artifact, "org-pilot");
  t.after(() => Promise.all([personal.dispose(),org.dispose()]));
  const a="10000000-0000-4000-8000-000000000001", b="10000000-0000-4000-8000-000000000002", scope="10000000-0000-4000-8000-000000000003";
  const call = async (app:typeof personal, path:string, body:unknown) => {
    const owner=app===personal ? {kind:"user" as const,id:"pilot-owner"} : {kind:"organization" as const,id:"pilot-org"};
    return app.fetch(app.origin+path,{method:"POST",headers:{...identityHeaderValues({userId:"pilot-owner",owner,installationId:app.installationId,role:"owner"}),"Content-Type":"application/json"},body:JSON.stringify(body)});
  };
  const action = (app:typeof personal, action:string, input:unknown) => call(app,"/api/internal/actions/v1/call",{action,input});
  const check = async (response:Response) => {assert.equal(response.status,200,await response.clone().text());return response.json() as Promise<Record<string,unknown>>;};
  for(const app of [personal,org]) await check(await call(app,"/api/internal/app-initialize",{}));
  const person=(id:string,title:string)=>({id,typeId:personTypeId,title});
  const anchor=(nodes:object[])=>nodes.map((attributes,i)=>({operation:"create",type:"graph-node",ref:`$anchor${i}`,attributes}));
  await check(await action(personal,"graph.apply",{requestKey:"people",operations:anchor([person(a,"Alex"),person(b,"Blair")])}));
  await check(await action(org,"graph.apply",{requestKey:"organization",operations:anchor([person(a,"Pilot owner"),{id:scope,typeId:"71000000-0000-4000-8000-000000000001",title:"Example organization"}])}));
  const personalGraph=personalControlPilot({id:a,name:"Alex"},{id:b,name:"Blair"}), orgGraph=organizationControlPilot(a,scope);
  for(const [app,graph] of [[personal,personalGraph],[org,orgGraph]] as const){
    const operations=[...graph.nodes.map((attributes,i)=>({operation:"create",type:"graph-node",ref:`$node${i}`,attributes})),...graph.edges.map((attributes,i)=>({operation:"create",type:"graph-edge",ref:`$edge${i}`,attributes}))];
    const request={requestKey:"pilot",operations};
    const first=await check(await action(app,"graph.apply",request));
    assert.deepEqual(await check(await action(app,"graph.apply",request)),first);
  }
  // friends_with is projected through the Friendship relator.
  const friends=async(app:typeof personal)=>((await check(await action(app,"graph.graphql",{query:"{ persons { nodes { id friendsWith { id } } } }"}))) as {data:{persons:{nodes:{id:string;friendsWith:{id:string}[]}[]}}}).data.persons.nodes;
  assert.deepEqual((await friends(personal)).find(node=>node.id===a)?.friendsWith.map(node=>node.id),[b]);
  assert.equal((await friends(org)).flatMap(node=>node.friendsWith).length,0);
  const get=(app:typeof personal,id:string)=>call(app,"/api/internal/entities/v1/get",{type:"graph-node",id});
  assert.equal((await get(org,pilotId(201))).status,404);
  assert.equal((await get(personal,pilotId(303))).status,404);
  const control=await check(await get(org,pilotId(303)));
  assert.equal((control.attributes as {properties:{state:string}}).properties.state,"proposed");
  const invalidId=pilotId(999);
  const invalid=await action(org,"graph.apply",{requestKey:"invalid-structured-control",operations:[{operation:"create",type:"graph-node",ref:"$invalid",attributes:{id:invalidId,typeId:pilotId(2),title:"Invalid control",body:"{}"}}]});
  assert.equal(invalid.status,400);
  assert.equal((await get(org,invalidId)).status,404);
  const episode=await check(await get(org,pilotId(305)));
  assert.equal((episode.attributes as {properties:{synthetic:boolean}}).properties.synthetic,true);
  assert.deepEqual(mergePilot(personalGraph,personalGraph),personalGraph);
  const authored=structuredClone(personalGraph);authored.nodes[0].body="Authored notes";
  assert.equal(mergePilot(authored,personalGraph).nodes[0].body,"Authored notes");
  assert.throws(()=>mergePilot({...personalGraph,nodes:[{...personalGraph.nodes[0],typeId:personTypeId}]},personalGraph),/Conflicting node identity/);
});

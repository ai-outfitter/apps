import assert from "node:assert/strict";
import test from "node:test";
import {appWorker} from "@ai-outfitter/app-test/worker";
const owner={userId:"editor",organizationId:"example-org",role:"owner"},member={...owner,userId:"reader",role:"member"};
const api="/api/apps/wiki-map/documents",entities="/api/internal/entities/v1";

test("document entities serve current authorized authored/generated context without exposing a write operation",async()=>{
 const app=await appWorker("wiki-map",new URL("../.outfitter/packages/operational.json",import.meta.url));
 try{
  const write=async(operation:string,input:object)=>{
   const response=await app.call(api,owner,{method:"POST",body:{operation,variables:{input}}});
   assert.equal(response.status,200,await response.clone().text());return await response.json() as Record<string,{id:string;revision:number}>;
  };
  const {saveDocument:document}=await write("SaveDocument",{title:"Project daily note",body:"Member authored notes"});
  await write("SaveGeneratedDocument",{id:document.id,revision:1,generatedBody:"Captured previous local-day evidence",provenance:{kind:"planning.daily-report"}});
  const types=await app.call(`${entities}/types`,member);
  assert.equal(types.status,200,await types.clone().text());
  const descriptors=await types.json() as {type:string;writable:boolean;operations:string[]}[];
  assert.deepEqual(descriptors.map(row=>({type:row.type,writable:row.writable,operations:row.operations})),[{type:"document",writable:false,operations:["list","get"]}]);
  const get=await app.call(`${entities}/get`,member,{method:"POST",body:{type:"document",id:document.id}});
  assert.equal(get.status,200,await get.clone().text());
  const entity=await get.json() as {ref:{type:string;id:string};revision:number;attributes:Record<string,unknown>};
  assert.equal(entity.ref.type,"document");assert.equal(entity.ref.id,document.id);assert.equal(entity.revision,2);
  assert.equal(entity.attributes.body,"Member authored notes");
  assert.equal(entity.attributes.generatedBody,"Captured previous local-day evidence");
  assert.equal((await app.call(`${entities}/get`,undefined,{method:"POST",body:{type:"document",id:document.id}})).status,401);
  assert.equal((await app.call(`${entities}/get`,{...member,role:"external"},{method:"POST",body:{type:"document",id:document.id}})).status,401);
  assert.equal((await app.call(`${entities}/update`,owner,{method:"POST",body:{type:"document",id:document.id,revision:2,attributes:{body:"Bypass"},references:[]}})).status,403);
  await write("ArchiveDocument",{id:document.id,revision:2});
  assert.equal((await app.call(`${entities}/get`,member,{method:"POST",body:{type:"document",id:document.id}})).status,404);
 }finally{await app.dispose();}
});

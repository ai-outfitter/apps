import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { parseDirectUpload } from "@ai-outfitter/app-sdk/storage";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { documents } from "../src/server/documents";
import { ProjectSchema } from "../src/lib/project";

test("an attachment preserves the saved assembly, checks the file and requires the current revision",async()=>{
 const app=await appWorker("workshop",appArtifact(new URL("..",import.meta.url),"operational"),"assembly-files");
 const member={userId:"designer",organizationId:"fixture",role:"member" as const};
 try {
  const created=await app.call("/api/apps/workshop/projects",member,{method:"POST",body:{example:"cube"}});
  const project=ProjectSchema.parse(await created.json());
  const itemId=randomUUID();
  const graph=async(name:"UploadWorkshopAssemblyFile"|"VerifyWorkshopAssemblyFile"|"UpdateWorkshopAssembly",variables:unknown)=>{
   const response=await app.call("/api/internal/actions/v1/call",member,{method:"POST",body:{action:name==="VerifyWorkshopAssemblyFile"?"graph.graphql":"graph.mutate",input:{query:documentText(documents[name].document),variables}}});
   const result=await response.json() as any;
   if(result.errors)throw Error(result.errors[0].message);
   return Object.values(result.data)[0] as any;
  };
  const {revision}=await graph("UpdateWorkshopAssembly",{projectId:project.id,expectedRevision:project.revision,assembly:{rootId:itemId,items:[{id:itemId,number:"part",revision:"A",name:"Fixture",kind:"assembly"}]}});
  const bytes=Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;");
  const verify={projectId:project.id,itemId,fileName:"fixture.step"};
  const input={...verify,expectedRevision:revision,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
  const upload=()=>graph("UploadWorkshopAssemblyFile",{input});
  const ticket=parseDirectUpload((await upload()).upload.url);
  assert.ok(ticket);
  const bucket=await app.bucket("main");
  await bucket.put(ticket.key,"corrupt");
  await assert.rejects(upload(),/match/i);
  await bucket.put(ticket.key,bytes);
  const receipt=await upload();
  assert.equal(receipt.revision,revision+1);
  assert.equal(receipt.status,"attached");
  assert.deepEqual(await upload(),receipt);
  assert.equal((await graph("VerifyWorkshopAssemblyFile",{input:verify})).file.sha256,input.sha256);
  await assert.rejects(graph("UploadWorkshopAssemblyFile",{input:{...input,fileName:"other.step"}}),/changed/i);
 } finally {await app.dispose();}
});

import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
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
  const itemId=randomUUID(), partId=randomUUID();
  const graph=async(name:"UploadWorkshopAssemblyFile"|"VerifyWorkshopAssemblyFile"|"UpdateWorkshopAssembly"|"WorkshopPrint",variables:unknown)=>{
   const response=await app.call("/api/internal/actions/v1/call",member,{method:"POST",body:{action:name==="VerifyWorkshopAssemblyFile"||name==="WorkshopPrint"?"graph.graphql":"graph.mutate",input:{query:documentText(documents[name].document),variables}}});
   const result=await response.json() as any;
   if(result.errors)throw Error(result.errors[0].message);
   return Object.values(result.data)[0] as any;
  };
  const {revision}=await graph("UpdateWorkshopAssembly",{projectId:project.id,expectedRevision:project.revision,assembly:{
    rootId:itemId,items:[
      {id:itemId,number:"fixture",revision:"A",name:"Fixture",kind:"assembly",
        uses:[{id:randomUUID(),itemId:partId,refdes:"P1",quantity:2,position:[0,0,0]}]},
      {id:partId,number:"part",revision:"A",name:"Fixture part",kind:"printed"},
    ],
  }});
  const print=await graph("WorkshopPrint",{input:{projectId:project.id}});
  assert.equal(print.parts[0].state,"pending");
  assert.equal(print.parts[0].quantity,2);
  assert.equal(print.parts[0].sha256,undefined);
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
  const saved=ProjectSchema.parse(await (await app.call("/api/apps/workshop/projects/"+project.id,member)).json());
  const assembly=structuredClone(saved.assembly);
  assembly.items[0].files![0].projectId=randomUUID();
  await assert.rejects(graph("UpdateWorkshopAssembly",{projectId:project.id,expectedRevision:receipt.revision,assembly}),/UploadWorkshopAssemblyFile/);
  const download=await app.call(receipt.file.downloadPath,member);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  await assert.rejects(graph("UploadWorkshopAssemblyFile",{input:{...input,fileName:"other.step"}}),/changed/i);
  const original=await readFile(new URL("../examples/mini-itx-case/exploded.png",import.meta.url));
  const image={...input, fileName:"purchase.PNG",expectedRevision:receipt.revision,bytes:original.length,sha256:createHash("sha256").update(original).digest("hex")};
  const attach=()=>graph("UploadWorkshopAssemblyFile",{input:image});
  const pending=parseDirectUpload((await attach()).upload.url);
  assert.ok(pending);
  await bucket.put(pending.key,original);
  const attached=await attach();
  assert.equal(attached.file.contentType,"image/png");
  const selection={...verify,fileName:image.fileName,expectedSha256:image.sha256};
  const parts:Buffer[]=[];
  let byteOffset:number|null=0;
  while(byteOffset!==null){
    const page=await graph("VerifyWorkshopAssemblyFile",{input:{...selection,byteOffset}});
    assert.equal(page.byteOffset,byteOffset);
    parts.push(Buffer.from(page.base64,"base64"));
    byteOffset=page.nextByteOffset;
  }
  assert.deepEqual(Buffer.concat(parts),original);
  await assert.rejects(graph("VerifyWorkshopAssemblyFile",{input:{...selection,expectedSha256:"0".repeat(64),byteOffset:0}}),/changed/);

 } finally {await app.dispose();}
});

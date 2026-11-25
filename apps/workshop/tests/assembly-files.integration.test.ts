import test from "node:test";
import assert from "node:assert/strict";
import {unzipSync,strFromU8} from "fflate";
import {readFile} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { parseDirectUpload } from "@ai-outfitter/app-sdk/storage";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { documents } from "../src/server/documents";
import { projectSlug } from "../src/lib/sections";
import { ProjectSchema } from "../src/lib/project";

test("an attachment preserves the saved assembly, checks the file and requires the current revision",async()=>{
 const app=await appWorker("workshop",appArtifact(new URL("..",import.meta.url),"operational"),"assembly-files");
 const member={userId:"designer",organizationId:"fixture",role:"member" as const};
 try {
  const created=await app.call("/api/apps/workshop/projects",member,{method:"POST",body:{example:"cube"}});
  const project=ProjectSchema.parse(await created.json());
  const itemId=randomUUID();
  const graph=async(name:"UploadWorkshopAssemblyFile"|"VerifyWorkshopAssemblyFile"|"UpdateWorkshopAssembly"|"RecordWorkshopFitTrial"|"WorkshopFitTrials",variables:unknown)=>{
   const response=await app.call("/api/internal/actions/v1/call",member,{method:"POST",body:{action:["WorkshopFitTrials","VerifyWorkshopAssemblyFile"].includes(name)?"graph.graphql":"graph.mutate",input:{query:documentText(documents[name].document),variables}}});
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

  // A field researcher checks the enclosure fit. The photo upload came after the tested design.
  const trial={projectId:project.id,trialId:randomUUID(),testedRevision:revision,title:"Sensor enclosure dry fit",
    photos:[{itemId,fileName:image.fileName,bytes:image.bytes,sha256:image.sha256,attachmentRevision:attached.revision,
      observation:"The board is visible. Its backing was omitted."}],
    interfaces:[{name:"Probe and backing",dimensionBasis:"supplier-nominal",component:"omitted",engagement:"untested",
      wireExit:"unchecked",finish:"rough",overhang:"observed",observation:"Backing omitted; wire bend and printed finish need checking."}]};
  const record=(input:unknown)=>graph("RecordWorkshopFitTrial",{input});
  const latest=ProjectSchema.parse(await (await app.call("/api/apps/workshop/projects/"+project.id,member)).json());
  // An ordinary subsequent edit removes the photo from the head. Both historical receipts still exist.
  latest.assembly.items[0].files=[];
  const after=await graph("UpdateWorkshopAssembly",{projectId:project.id,expectedRevision:latest.revision,assembly:latest.assembly});
  await assert.rejects(record({...trial,interfaces:[{...trial.interfaces[0],engagement:"fits"}]}),/omitted/);
  await assert.rejects(record({...trial,photos:[{...trial.photos[0],sha256:"0".repeat(64)}]}),/receipt/);
  await assert.rejects(record({...trial,photos:[{...trial.photos[0],attachmentRevision:revision}]}),/receipt/);
  await assert.rejects(record({...trial,pcbSnapshotId:randomUUID()}),/PCB snapshot/);
  const captured=await record(trial);
  assert.equal(captured.testedRevision,revision);
  assert.equal(captured.photos[0].attachmentRevision,attached.revision);
  assert.equal(captured.advisories.length,7);
  assert.match(captured.rapidFitGuidance,/mating section/);
  assert.deepEqual(await record(trial),captured);
  await assert.rejects(record({...trial,title:"Conflicting submission"}),/different evidence/);
  const read=(testedRevision:number)=>graph("WorkshopFitTrials",{input:{projectId:project.id,testedRevision}});
  assert.deepEqual(await read(revision),[captured]);
  assert.deepEqual(await read(after.revision),[]);
  assert.equal((await (await app.call("/api/apps/workshop/projects/"+project.id,member)).json() as any).revision,after.revision);
  const html=await (await app.call("/projects/"+projectSlug(latest)+"/release",member)).text();
  assert.ok(html.includes("Physical fit trials") && html.includes(trial.title) && html.includes(image.sha256));
  assert.deepEqual(Buffer.from(await (await app.call(captured.photos[0].downloadPath,member)).arrayBuffer()),original);
  const exported=await app.call("/api/apps/workshop/projects/"+project.id+"/package",member);
  const archive=unzipSync(new Uint8Array(await exported.arrayBuffer()));
  assert.deepEqual(JSON.parse(strFromU8(archive["fit-trials.json"])),[captured]);


 } finally {await app.dispose();}
});

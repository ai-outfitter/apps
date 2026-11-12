import assert from "node:assert/strict";
import test from "node:test";
import {appWorker} from "@ai-outfitter/app-test/worker";
import {appArtifact} from "@ai-outfitter/app-test/prepare";
import {documentText} from "@ai-outfitter/app-sdk/graph-graphql-typed";
import {identityHeaderValues,sha256Hex} from "@ai-outfitter/app-sdk/server";
import {documents} from "../src/server/documents";
import {parseDirectUpload} from "@ai-outfitter/app-sdk/storage";

test("release assets upload through the packaged authenticated route and reconcile through the published document",async()=>{
 const app=await appWorker("software-foundry",appArtifact(new URL("..",import.meta.url),"operational"),"release-evidence-fixture");
 try{
  const who={userId:"synthetic-editor",organizationId:"synthetic-org",role:"owner"};
  const asset={key:crypto.randomUUID(),path:"manifest.json",contentType:"application/json",size:2,sha256:await sha256Hex("{}")};
  const variables={input:{bundle:"synthetic-release",assets:[asset]}};
  const reserve=async()=>{
   const response=await app.call("/api/internal/actions/v1/call",who,{method:"POST",body:{action:"graph.mutate",input:{query:documentText(documents.SubmitReleaseEvidence.document),variables}}});
   assert.equal(response.status,200,await response.clone().text());
   const result=await response.json() as any;
   assert.equal(result.errors,undefined,JSON.stringify(result));return result.data.submitReleaseEvidence;
  };
  const reserved=await reserve();
  assert.equal(reserved.items[0].status,"pending");
  const ticket=reserved.items[0].result;
  const anonymous=await app.fetch(ticket.authenticatedUploadUrl,{method:"PUT",headers:{"content-type":"application/json"},body:"{}"});
  assert.equal(anonymous.status,401);
  const headers=new Headers(identityHeaderValues({...who,installationId:app.installationId}));headers.set("content-type","application/json");
  const upload=await app.fetch(ticket.authenticatedUploadUrl,{method:"PUT",headers,body:"{}"});
  assert.equal(upload.status,200,await upload.clone().text());
  const done=await reserve();assert.equal(done.items[0].status,"complete");assert.deepEqual(done.instructions,[]);
  const stored=await (await app.bucket("main")).get("evidence/synthetic-release/manifest.json");
  assert.equal(await stored?.text(),"{}");
  const row=await app.database.prepare("SELECT createdBy,visibility FROM app_storage_objects WHERE key=?").bind("synthetic-release/manifest.json").first<any>();
  assert.equal(row.createdBy,who.userId);assert.equal(row.visibility,"organization");
 }finally{await app.dispose();}
});

test("release assets PUT straight into the bucket through the presigned ticket, are verified, then published",async()=>{
 const app=await appWorker("software-foundry",appArtifact(new URL("..",import.meta.url),"operational"),"release-evidence-direct-fixture");
 try{
  const who={userId:"synthetic-editor",organizationId:"synthetic-org",role:"owner"};
  const png=Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0dc5a6b70000000049454e44ae426082","hex");
  const asset={key:crypto.randomUUID(),path:"images/story/001-desktop.png",contentType:"image/png",size:png.byteLength,sha256:await sha256Hex(png)};
  const variables={input:{bundle:"synthetic-direct",assets:[asset]}};
  const reserve=async()=>{
   const response=await app.call("/api/internal/actions/v1/call",who,{method:"POST",body:{action:"graph.mutate",input:{query:documentText(documents.SubmitReleaseEvidence.document),variables}}});
   assert.equal(response.status,200,await response.clone().text());
   const result=await response.json() as any;
   assert.equal(result.errors,undefined,JSON.stringify(result));return result.data.submitReleaseEvidence;
  };
  const reserved=await reserve();
  assert.equal(reserved.items[0].status,"pending");
  const ticket=reserved.items[0].result;
  assert.equal(ticket.authenticationRequired,false);
  assert.deepEqual(ticket.headers,{"Content-Type":"image/png","Content-Length":String(png.byteLength)});
  // The platform presigns this reference; here the test plays R2 and writes the staged key.
  const reference=parseDirectUpload(ticket.uploadUrl);
  assert.ok(reference,ticket.uploadUrl);
  assert.equal(reference.bucket,"main");
  assert.equal(reference.key,`_uploads/${asset.sha256}/evidence/synthetic-direct/images/story/001-desktop.png`);
  assert.deepEqual([reference.contentType,reference.size],["image/png",png.byteLength]);
  assert.equal(reserved.instructions[0].code,"UPLOAD_RELEASE_ASSET");
  const bucket=await app.bucket("main");
  // Wrong bytes are discarded and refused, and the asset can be uploaded again.
  await bucket.put(reference.key,Buffer.alloc(png.byteLength));
  const refused=await reserve();
  assert.equal(refused.items[0].status,"failed");
  assert.equal(await bucket.get(reference.key),null);
  await bucket.put(reference.key,png);
  const done=await reserve();
  assert.equal(done.items[0].status,"complete",JSON.stringify(done));
  assert.deepEqual(done.instructions,[]);
  assert.match(done.items[0].result.url,/\/files\/main\/evidence\/synthetic-direct\/images\/story\/001-desktop\.png$/);
  const stored=await bucket.get("evidence/synthetic-direct/images/story/001-desktop.png");
  assert.deepEqual(Buffer.from(await stored!.arrayBuffer()),png);
  assert.equal(await bucket.get(reference.key),null);
  const again=await reserve();assert.equal(again.items[0].status,"complete");
 }finally{await app.dispose();}
});

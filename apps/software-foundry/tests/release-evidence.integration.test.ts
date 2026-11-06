import assert from "node:assert/strict";
import test from "node:test";
import {appWorker} from "@ai-outfitter/app-test/worker";
import {appArtifact} from "@ai-outfitter/app-test/prepare";
import {documentText} from "@ai-outfitter/app-sdk/graph-graphql-typed";
import {identityHeaderValues,sha256Hex} from "@ai-outfitter/app-sdk/server";
import {documents} from "../src/server/documents";

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
  const anonymous=await app.fetch(ticket.uploadUrl,{method:"PUT",headers:{"content-type":"application/json"},body:"{}"});
  assert.equal(anonymous.status,401);
  const headers=new Headers(identityHeaderValues({...who,installationId:app.installationId}));headers.set("content-type","application/json");
  const upload=await app.fetch(ticket.uploadUrl,{method:"PUT",headers,body:"{}"});
  assert.equal(upload.status,200,await upload.clone().text());
  const done=await reserve();assert.equal(done.items[0].status,"complete");assert.deepEqual(done.instructions,[]);
  const stored=await (await app.bucket("main")).get("evidence/synthetic-release/manifest.json");
  assert.equal(await stored?.text(),"{}");
  const row=await app.database.prepare("SELECT createdBy,visibility FROM app_storage_objects WHERE key=?").bind("synthetic-release/manifest.json").first<any>();
  assert.equal(row.createdBy,who.userId);assert.equal(row.visibility,"organization");
 }finally{await app.dispose();}
});

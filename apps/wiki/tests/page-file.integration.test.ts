import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseDirectUpload } from "@ai-outfitter/app-sdk/storage";
import { appWorker } from "@ai-outfitter/app-test/worker";
import catalog from "../graph/documents.json";

test("a Wiki editor can attach verified bytes and a member can reopen the source from its page", async () => {
 const app = await appWorker("wiki-map", new URL("../.outfitter/packages/operational.json", import.meta.url));
 const owner = {userId:"editor", organizationId:"fixture", role:"owner"};
 const member = {...owner,userId:"reader",role:"member"};
 const bytes = Buffer.from("Disposable interview transcript.\n");
 const input = {pageSlug:"interview", fileName:"interview.txt", contentType:"text/plain", size:bytes.length, sha256:createHash("sha256").update(bytes).digest("hex")};
 const operation = catalog.find(row => row.name === "UploadWikiPageFile");
 assert.ok(operation);
 async function upload(who=owner, pageSlug=input.pageSlug) {
  const response = await app.call("/api/internal/actions/v1/call",who,{method:"POST",body:{
   action:"graph.mutate",input:{query:operation!.query,variables:{input:{...input,pageSlug}}}
  }});
  if (!response.ok) throw Error(`${response.status} ${await response.text()}`);
  const result = await response.json() as any;
  if (result.errors) throw Error(JSON.stringify(result));
  return result.data.uploadWikiPageFile;
 }
 try {
  const created = await app.call("/api/apps/wiki-map/documents",owner,{method:"POST",body:{operation:"SaveDocument",variables:{input:{slug:"interview",title:"Interview",body:"Notes"}}}});
  assert.equal(created.status,200);
  await assert.rejects(upload(owner,"unknown-page"),/Page not found/);
  await assert.rejects(upload(member),/403/);
  const pending = await upload();
  assert.equal(pending.status,"awaiting_upload");
  const target = parseDirectUpload(pending.upload.url);
  assert.ok(target);
  const bucket = await app.bucket(target.bucket);
  await bucket.put(target.key,Buffer.alloc(bytes.length));
  await assert.rejects(upload(),/do not match/);
  await bucket.put(target.key,bytes);
  const receipt = await upload();
  assert.equal(receipt.status,"attached");
  assert.equal(receipt.sha256,input.sha256);
  assert.deepEqual(await upload(),receipt);
  const page = await app.call("/p/interview",member);
  assert.ok((await page.text()).includes(("/" + receipt.downloadUrl)));
  assert.equal((await app.call(("/" + receipt.downloadUrl))).status,404);
  const download = await app.call(("/" + receipt.downloadUrl),member);
  assert.equal(download.status,200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
 } finally {await app.dispose();}
});

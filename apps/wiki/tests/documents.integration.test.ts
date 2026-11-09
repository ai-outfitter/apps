import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";

const owner={userId:"editor",organizationId:"example-org",role:"owner"};
const member={...owner,userId:"reader",role:"member"};
const api="/api/apps/wiki-map/documents";
test("installed Wiki creates a draft, preserves a publication, and refuses stale or unauthorized writes",async()=>{
 const app=await appWorker("wiki-map",new URL("../.outfitter/packages/operational.json",import.meta.url));
 try{
  const call=(operation:string,input:object,who=owner)=>app.call(api,who,{method:"POST",body:{operation,variables:{input}}});
  const created=await call("SaveDocument",{title:"Project notes",body:"Original **notes**",slug:"project-notes"});
  assert.equal(created.status,200,await created.clone().text());
  const first=(await created.json() as {saveDocument:{id:string;revision:number;publishedRevision:number|null}}).saveDocument;
  assert.equal(first.publishedRevision,null);
  const page=await app.call("/p/project-notes",member);assert.equal(page.status,200);assert.match(await page.text(),/Original <strong>notes<\/strong>/);
  assert.equal((await call("PublishDocument",{id:first.id,revision:1})).status,200);
  assert.equal((await call("SaveDocument",{id:first.id,revision:1,title:"Updated notes",body:"Draft update"})).status,200);
  assert.equal((await call("SaveDocument",{id:first.id,revision:1,title:"Stale"})).status,409);
  assert.equal((await call("SaveDocument",{title:"No access"},member)).status,403);
  const published=await app.call(`/p/project-notes?revision=1`,member);assert.match(await published.text(),/Original/);
  const read=await app.call(api,member,{method:"POST",body:{operation:"WikiDocument",variables:{id:first.id}}});
  const data=await read.json() as {document:{revision:number;publishedRevision:number};documentRevisions:unknown[]};
  assert.deepEqual([data.document.revision,data.document.publishedRevision,data.documentRevisions.length],[2,1,2]);
  const legacy=await app.call(`/documents/${first.id}`,member);assert.equal(legacy.status,200);assert.match(await legacy.text(),/Updated notes/);
  const oldWrite=await app.call("/api/apps/wiki-map/graph/apply",owner,{method:"POST",body:{}});assert.notEqual(oldWrite.status,200);
 }finally{await app.dispose();}
});

test("demo Wiki serves documents and refuses writes without an installation database",async()=>{
 const app=await appWorker("wiki-map",new URL("../.outfitter/packages/demo.json",import.meta.url));
 try{
  const page=await app.call("/p/welcome",owner);assert.equal(page.status,200);assert.match(await page.text(),/Welcome to Wiki/);
  assert.equal((await app.call(api,owner,{method:"POST",body:{operation:"SaveDocument",variables:{input:{title:"No"}}}})).status,403);
 }finally{await app.dispose();}
});

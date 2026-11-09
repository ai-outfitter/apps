import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";

const owner={userId:"editor",organizationId:"example-org",role:"owner"};
const member={...owner,userId:"reader",role:"member"};
const api="/api/apps/wiki-map/documents";
test("operational Wiki serves an anonymous installation shell before initialization without reading documents",async()=>{
 const app=await appWorker("wiki-map",new URL("../.outfitter/packages/operational.json",import.meta.url));
 try{
  // Match deployment admission: no forwarded identity and no initializer call.
  const health=await app.call("/__health");
  assert.equal(health.status,200);
  const status=await health.json() as {app:string;status:string;database:string};
  assert.deepEqual([status.app,status.status,status.database],["wiki-map","ok","ok"]);
  const page=await app.call("/");
  assert.equal(page.status,200,await page.clone().text());
  assert.match(page.headers.get("content-type") ?? "",/text\/html/);
  assert.equal(page.headers.get("cache-control"),"private, no-store");
  const html=await page.text();
  assert.match(html,/Open Wiki through your workspace/);
  const paths=new Set([...Object.keys(app.assets).filter(path=>/^\/_astro\/.*\.(?:js|css)$/.test(path)),...Array.from(html.matchAll(/(?:src|href)="(\/_astro\/[^"?#]+)"/g),match=>match[1])]);
  assert.ok(paths.size>0,"the entry shell links its compiled assets");
  for(const path of paths){
   const asset=await app.call(path);
   assert.equal(asset.status,200,path);
   assert.match(asset.headers.get("content-type") ?? "",path.endsWith(".css")?/text\/css/:/javascript/,path);
   await asset.arrayBuffer();
  }
  const created=await app.call(api,owner,{method:"POST",body:{operation:"SaveDocument",variables:{input:{title:"Private installation notes",body:"Private fixture body",slug:"private-installation-notes"}}}});
  assert.equal(created.status,200,await created.clone().text());
  const anonymous=await app.call("/");
  assert.equal(anonymous.status,200);
  assert.doesNotMatch(await anonymous.text(),/Private installation notes|Private fixture body/);
  const authenticated=await app.call("/",member);
  assert.equal(authenticated.status,200);
  assert.equal(authenticated.headers.get("cache-control"),"private, no-store");
  assert.match(await authenticated.text(),/Private installation notes/);
  assert.equal((await app.call(api,undefined,{method:"POST",body:{operation:"WikiDocuments",variables:{}}})).status,401);
  // A missing document store must not turn the anonymous entry into a data read.
  await app.database.exec("DROP TABLE wiki_pages; DROP TABLE wiki_document_revisions; DROP TABLE wiki_documents;");
  const withoutStore=await app.call("/");
  assert.equal(withoutStore.status,200,await withoutStore.clone().text());
  assert.match(await withoutStore.text(),/Open Wiki through your workspace/);
 }finally{await app.dispose();}
});

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
  for(const path of ["/documents/project-notes",`/page?node=${first.id}`,"/page?slug=project-notes"]){const oldPage=await app.call(path,member);assert.equal(oldPage.status,200);assert.match(await oldPage.text(),/Updated notes/);}
  const documentIndex=await app.call("/documents",member);assert.equal(documentIndex.status,200);assert.match(await documentIndex.text(),/Your Wiki/);
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

test("an entity page reads Onto without copying its entity and loses source access safely",async()=>{
 let readable=true;
 const app=await appWorker("wiki-map",new URL("../.outfitter/packages/operational.json",import.meta.url),"wiki-map-installation",{workflowHost:()=>({async call(operation,input){
  if(operation==="entities.types")return {ok:true,value:(input as {template:string}).template==="onto"?["graph-type","graph-node","graph-edge"].map(type=>({installationId:"onto",type,writable:true,title:type,description:"",schema:{}})):[]};
  if(operation==="entities.get"&&readable)return {ok:true,value:{ref:{installationId:"onto",type:"graph-node",id:"person"},revision:1,title:"Ada",attributes:{slug:"ada",summary:"Project collaborator",body:"Shared **context**"},references:[]}};
  return {ok:false,status:403,message:"Source unavailable"};
 }})});
 const scope={organizationId:owner.organizationId,installationId:app.installationId,userId:owner.userId,packageHash:"fixture",phase:"interactive" as const,expiresAt:Date.now()+60000};
 try{
  const before=await app.database.prepare("SELECT count(*) AS count FROM wiki_documents").first<{count:number}>();
  const typesResponse=await app.call("/api/internal/threads/v1/types",owner,{method:"POST",body:{},workflowHost:scope});
  assert.equal(typesResponse.status,200,await typesResponse.clone().text());
  assert.match(await typesResponse.text(),/wiki-map.conversation/);
  const created=await app.call(api,owner,{method:"POST",body:{operation:"SavePage",variables:{input:{slug:"ada",entityRef:{installationId:"onto",type:"graph-node",id:"person"}}}}});
  assert.equal(created.status,200,await created.clone().text());
  const page=await app.call("/p/ada",owner,{workflowHost:scope});
  assert.match(await page.text(),/Shared <strong>context<\/strong>/);
  assert.equal((await app.database.prepare("SELECT count(*) AS count FROM wiki_documents").first<{count:number}>())?.count,before?.count);
  readable=false;
  const lost=await app.call("/p/ada",owner,{workflowHost:scope});
  assert.match(await lost.text(),/Linked information is currently unavailable/);
 }finally{await app.dispose();}
});

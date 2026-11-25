import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import migrationHashes from "./legacy-migrations.json";
import {graphql} from "graphql";
import {graphqlSchema} from "../src/documents/graphql";
import {resumeLegacyImport} from "../src/documents/resume-import";
import {requireGraphCutover} from "../src/documents/cutover";
import {workflowHost} from "@ai-outfitter/app-sdk/workflow-host";
import { DatabaseSync } from "node:sqlite";
import { readdirSync,readFileSync } from "node:fs";
import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import { saveGeneratedDocument,archiveDocument,documentDigest,getDocument,listPages,publishDocument,revisions,saveDocument,savePage } from "../src/documents/store";

const who={userId:"member",installationId:"wiki",owner:{kind:"user" as const,id:"member"},role:"owner",canEdit:true};
function fixture(withImportRevision=true, authored=true, migrationTime?:number) {
 const sqlite=new DatabaseSync(":memory:"); sqlite.exec("PRAGMA foreign_keys=ON");
 if(migrationTime!==undefined) sqlite.function("unixepoch",()=>migrationTime);
 const folder=new URL("../migrations/",import.meta.url);
 for(const name of readdirSync(folder).filter(n=>n.endsWith('.sql') && n<'0012').sort()) sqlite.exec(readFileSync(new URL(name,folder),'utf8'));
 if(authored) sqlite.exec(`INSERT INTO graph_nodes(id,typeId,slug,title,body,revision,createdAt,updatedAt) VALUES('legacy',(SELECT id FROM graph_types WHERE name='Document'),'old-page','Original','Original body',2,1,2);
 INSERT INTO graph_revisions(kind,recordId,revision,proposedBy,approval,evidence,snapshot,createdAt) VALUES('graph-node','legacy',1,'member','{}','[]','{"title":"First","body":"First body"}',1);`);
 sqlite.exec(readFileSync(new URL('0012_documents.sql',folder),'utf8'));
 if(withImportRevision) for(const name of readdirSync(folder).filter(n=>n.endsWith('.sql') && n>='0013').sort()) sqlite.exec(readFileSync(new URL(name,folder),'utf8'));
 const db:AgentDatabase={query:async s=>sqlite.prepare(s.sql).all(...(s.params ?? []) as never[]) as Record<string,unknown>[],batch:async steps=>{
  sqlite.exec('BEGIN');try{for(const s of steps)sqlite.prepare(s.sql).run(...(s.params ?? []) as never[]);sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}
 }};
 return {sqlite,db};
}
test('forward migration preserves document IDs, history, content, and the source graph',async()=>{
 const {sqlite,db}=fixture();try{
  const head=await getDocument(db,'legacy');assert.equal(head.body,'Original body');assert.equal(head.revision,2);assert.equal(head.publishedRevision,null);
  assert.deepEqual((await revisions(db,'legacy')).map(r=>r.body),['Original body','First body']);
  assert.equal((await listPages(db))[0].slug,'old-page');
  assert.equal(sqlite.prepare('SELECT body FROM graph_nodes WHERE id=?').get('legacy')?.body,'Original body');
  assert.throws(()=>sqlite.exec("UPDATE wiki_document_revisions SET body='lost'"),/immutable/);
 }finally{sqlite.close();}
});
test('edits retain publication and stale writers cannot create orphan revisions',async()=>{
 const {sqlite,db}=fixture();try{
  await publishDocument(db,who,{id:'legacy',revision:2});
  const next=await saveDocument(db,who,{id:'legacy',revision:2,title:'New',body:'Draft'});
  assert.equal(next.revision,3);assert.equal(next.publishedRevision,2);
  await assert.rejects(saveDocument(db,who,{id:'legacy',revision:2,title:'Lost update'}),e=>e instanceof Response&&e.status===409);
  assert.equal((await revisions(db,'legacy')).length,3);
  assert.equal((await getDocument(db,'legacy',2)).body,'Original body');
  await assert.rejects(saveDocument(db,{...who,canEdit:false,role:'member'},{title:'Unauthorized'}),e=>e instanceof Response&&e.status===403);
 }finally{sqlite.close();}
});
test('approval must match this revision and digest; configuration is revision guarded',async()=>{
 const {sqlite,db}=fixture();try{
  const page=(await listPages(db))[0];
  await savePage(db,who,{id:page.id,revision:page.revision,slug:page.slug,documentId:'legacy',autoPublish:true,policyRef:{installationId:'governance',type:'control',id:'review'}});
  await assert.rejects(publishDocument(db,who,{id:'legacy',revision:2}),e=>e instanceof Response&&e.status===409);
  await assert.rejects(publishDocument(db,who,{id:'legacy',revision:2},async()=>({allowed:true,revision:1,digest:'old'})),e=>e instanceof Response&&e.status===409);
  const digest=await documentDigest(await getDocument(db,'legacy'));
  assert.equal((await publishDocument(db,who,{id:'legacy',revision:2},async()=>({allowed:true,revision:2,digest}))).publishedRevision,2);
  await assert.rejects(savePage(db,who,{id:page.id,revision:page.revision,slug:page.slug,documentId:'legacy'}),e=>e instanceof Response&&e.status===409);
  await assert.rejects(savePage(db,who,{id:page.id,revision:2,slug:page.slug,documentId:'legacy',parentId:page.id}),e=>e instanceof Response&&e.status===400);
  await archiveDocument(db,who,{id:'legacy',revision:2});assert.equal((await revisions(db,'legacy')).length,2);
 }finally{sqlite.close();}
});


test('installed legacy migration files are unchanged',()=>{
 for(const [name,expected] of Object.entries(migrationHashes)) assert.equal(createHash('sha256').update(readFileSync(new URL(`../migrations/${name}`,import.meta.url))).digest('hex'),expected,name);
});

test('reader provenance does not expose the original private graph snapshot',async()=>{
 const {sqlite,db}=fixture();try{
  const raw=JSON.stringify({kind:'legacy-graph',snapshot:{privateData:{secret:'private-source-value'}},prior:{body:'private-original'},batchId:'batch'});
  // Simulate a preserved source snapshot before the immutable history seal.
  sqlite.exec('DROP TRIGGER wiki_revisions_no_update');
  sqlite.prepare('UPDATE wiki_document_revisions SET provenance=? WHERE documentId=? AND revision=2').run(raw,'legacy');
  const result=await graphql({schema:graphqlSchema,source:'{document(id:"legacy"){id provenance}}',contextValue:{database:db,identity:who}});
  assert.equal(result.errors,undefined);
  assert.deepEqual(JSON.parse(String((result.data?.document as {provenance:string}).provenance)),{kind:'legacy-graph',batchId:'batch'});
  assert.ok(!JSON.stringify(result).includes('private-source-value'));
  assert.ok(String(sqlite.prepare('SELECT provenance FROM wiki_document_revisions WHERE documentId=? AND revision=2').get('legacy')?.provenance).includes('private-source-value'));
 }finally{sqlite.close();}
});

test('a changed legacy graph cannot activate the document Wiki without its migration receipt',async()=>{
 const {sqlite,db}=fixture();let migrated=false;
 const host=workflowHost<"interactive">({props:{workflowHost:{async call(operation:string,input:unknown){
  if(operation==='entities.types')return {ok:true,value:(input as {template:string}).template==='onto'?['graph-type','graph-node','graph-edge'].map(type=>({installationId:'onto',type,title:type,description:'',schema:{},writable:true})):[]};
  return {ok:true,value:{sourceInstallationIds:migrated?[who.installationId]:[]}};
 }}}});
 try{
  await assert.rejects(requireGraphCutover(db,who,host),error=>error instanceof Response&&error.status===409);
  migrated=true;await requireGraphCutover(db,who,host);
 }finally{sqlite.close();}
});

test('a resumed activation imports intervening legacy revisions and leaves Wiki edits intact',async()=>{
 const {sqlite,db}=fixture();try{
  sqlite.exec("UPDATE graph_nodes SET revision=3,body='Legacy edit during rollback' WHERE id='legacy'");
  await resumeLegacyImport(db);
  assert.equal((await getDocument(db,'legacy')).body,'Legacy edit during rollback');
  assert.equal((await revisions(db,'legacy')).length,3);
  await saveDocument(db,who,{id:'legacy',revision:3,title:'Wiki edit',body:'Authored in Wiki'});
  await resumeLegacyImport(db);
  assert.equal((await getDocument(db,'legacy')).body,'Authored in Wiki');
  sqlite.exec("UPDATE graph_nodes SET revision=5,body='Conflicting source' WHERE id='legacy'");
  await assert.rejects(resumeLegacyImport(db),error=>error instanceof Response && error.status===409);
  assert.equal((await getDocument(db,'legacy')).body,'Authored in Wiki');
  assert.equal((await revisions(db,'legacy')).length,4);
 }finally{sqlite.close();}
});

test('the import marker upgrade does not mistake existing Wiki edits for imported history',async()=>{
 const {sqlite,db}=fixture(false);try{
  await saveDocument(db,who,{id:'legacy',revision:2,title:'Existing Wiki edit',body:'Keep this draft'});
  sqlite.exec(readFileSync(new URL('../migrations/0013_imported_revision.sql',import.meta.url),'utf8'));
  assert.equal(sqlite.prepare("SELECT importedRevision FROM wiki_documents WHERE id='legacy'").get()?.importedRevision,2);
  sqlite.exec("UPDATE graph_nodes SET revision=4,body='Later legacy change' WHERE id='legacy'");
  await assert.rejects(resumeLegacyImport(db),error=>error instanceof Response&&error.status===409);
  assert.equal((await getDocument(db,'legacy')).body,'Keep this draft');
 }finally{sqlite.close();}
});

test("nullable page lookup distinguishes absence from a failed document read",async()=>{
 const {db}=fixture();
 const contextValue={database:db,identity:who};
 const missing=await graphql({schema:graphqlSchema,source:'query {page(slug:"missing"){documentId}}',contextValue});
 assert.equal(missing.errors,undefined);
 assert.equal(missing.data?.page,null);
 const broken=await graphql({schema:graphqlSchema,source:'query {page(slug:"missing"){documentId}}',contextValue:{...contextValue,database:{query:async()=>{throw new Error("Source unavailable");}}}});
 assert.equal(broken.errors?.[0].message,"Source unavailable");
});


test("a page returns its document and that document's address in one request",async()=>{
 const {db}=fixture();
 const saved=await saveGeneratedDocument(db,who,{slug:"daily-one",title:"Daily",generatedBody:"Frozen snapshot",provenance:{kind:"test"}});
 const read=await graphql({schema:graphqlSchema,source:'query {page(slug:"daily-one"){document{id installationId revision generatedBody archived}}}',contextValue:{database:db,identity:who}});
 assert.equal(read.errors,undefined);
 assert.deepEqual(JSON.parse(JSON.stringify(read.data?.page)),{document:{id:saved.id,installationId:who.installationId,revision:1,generatedBody:"Frozen snapshot",archived:false}});
});

test("generated drafts revise changed source while preserving authored body, publication and optimistic revision",async()=>{
 const {db}=fixture();
 const created=await saveDocument(db,who,{title:"Daily note",body:"Member authored notes"});
 await publishDocument(db,who,{id:created.id,revision:1});
 const generated=await saveGeneratedDocument(db,who,{id:created.id,revision:1,generatedBody:"Captured source A",provenance:{kind:"planning.daily-report",inputDigest:"a"}});
 assert.equal(generated.body,"Member authored notes");
 assert.equal(generated.publishedRevision,1);
 assert.equal(generated.revision,2);
 const unchanged=await saveGeneratedDocument(db,who,{id:created.id,revision:2,generatedBody:"Captured source A",provenance:{kind:"planning.daily-report",inputDigest:"a"}});
 assert.equal(unchanged.revision,2);
 await assert.rejects(saveGeneratedDocument(db,who,{id:created.id,revision:1,generatedBody:"Stale source",provenance:{}}),error=>error instanceof Response && error.status===409);
 const revised=await saveGeneratedDocument(db,who,{id:created.id,revision:2,generatedBody:"Captured source B",provenance:{kind:"planning.daily-report",inputDigest:"b"}});
 assert.equal(revised.body,"Member authored notes");
 assert.equal(revised.publishedRevision,1);
 assert.equal((await getDocument(db,created.id,1)).generatedBody,"");
 assert.equal((await getDocument(db,created.id,2)).generatedBody,"Captured source A");
 await assert.rejects(saveGeneratedDocument(db,{...who,role:"member",canEdit:false},{id:created.id,revision:3,generatedBody:"Unauthorized",provenance:{}}),error=>error instanceof Response && error.status===403);
});

test("generated draft creation is atomic and duplicate slugs cannot leave an empty document shell",async()=>{
 const {db}=fixture();
 const created=await saveGeneratedDocument(db,who,{slug:"atomic-daily",title:"Atomic report",generatedBody:"Captured source",provenance:{kind:"planning.daily-report"}});
 assert.equal(created.revision,1);assert.equal(created.body,"");assert.equal(created.generatedBody,"Captured source");
 const before=await db.query({sql:"SELECT count(*) AS count FROM wiki_documents"});
 await assert.rejects(saveGeneratedDocument(db,who,{slug:"atomic-daily",title:"Duplicate",generatedBody:"Other source",provenance:{}}));
 assert.deepEqual(await db.query({sql:"SELECT count(*) AS count FROM wiki_documents"}),before);
 await assert.rejects(saveGeneratedDocument(db,who,{slug:"invalid",title:"Invalid",generatedBody:"x".repeat(200001),provenance:{}}));
 assert.deepEqual(await db.query({sql:"SELECT count(*) AS count FROM wiki_documents"}),before);
});


test('document navigation reads metadata, includes only real Profile/Notes trees, and bounds cycles',async()=>{
 const {navigationPages,documentTrees}=await import('../src/documents/navigation');
 const {sqlite,db}=fixture();try{
  assert.deepEqual(documentTrees(await navigationPages(db)),[]);
  const notes=await saveDocument(db,who,{title:'Notes',slug:'notes',body:'PRIVATE BODY'});
  const child=await saveDocument(db,who,{title:'Notebook child',slug:'notebook-child',body:'PRIVATE CHILD'});
  const pages=await listPages(db),parent=pages.find(page=>page.documentId===notes.id)!;
  const childPage=pages.find(page=>page.documentId===child.id)!;
  await savePage(db,who,{id:childPage.id,revision:childPage.revision,slug:childPage.slug,documentId:child.id,parentId:parent.id});
  const metadata=await navigationPages(db);
  assert.ok(!JSON.stringify(metadata).includes('PRIVATE'));
  assert.deepEqual(documentTrees(metadata).map(page=>[page.title,page.depth]),[['Notes',0],['Notebook child',1]]);
  await archiveDocument(db,who,{id:child.id,revision:1});
  assert.deepEqual(documentTrees(await navigationPages(db)).map(page=>page.title),['Notes']);
  assert.deepEqual(documentTrees([{id:'cycle',slug:'notes',title:'Notes',parentId:'cycle'}]),[]);
 }finally{sqlite.close();}
});
test('recent updates use descending timestamp/id pagination without bodies or archived documents',async()=>{
 const {recentDocuments,recentCursor,relatedType}=await import('../src/documents/navigation');
 const {sqlite,db}=fixture();try{
  for(let n=0;n<52;n++)await saveDocument(db,who,{title:`Note ${n}`,body:'PRIVATE BODY'});
  sqlite.exec('UPDATE wiki_documents SET updatedAt=100');
  const first=await recentDocuments(db);assert.equal(first.length,51);
  assert.ok(!JSON.stringify(first).includes('PRIVATE'));
  const last=first[49],next=await recentDocuments(db,{updatedAt:last.updatedAt,id:last.id});
  assert.equal(next.length,3);
  assert.equal(new Set([...first.slice(0,50),...next].map(doc=>doc.id)).size,53);
  await archiveDocument(db,who,{id:next[0].id,revision:next[0].revision});
  assert.ok(!(await recentDocuments(db,{updatedAt:last.updatedAt,id:last.id})).some(doc=>doc.id===next[0].id));
  assert.deepEqual(recentCursor(new URLSearchParams('before=100&id=test')),{updatedAt:100,id:'test'});
  assert.throws(()=>recentCursor(new URLSearchParams('before=NaN&id=x')),error=>error instanceof Response&&error.status===400);
  assert.equal(relatedType('Goal'),'Goal');assert.equal(relatedType(null),undefined);
  assert.throws(()=>relatedType('Secret'),error=>error instanceof Response&&error.status===400);
 }finally{sqlite.close();}
});

test("daily app publication reaches the federated document with exact date, revision and coverage", async () => {
 const {db,sqlite}=fixture();
 try {
  const {serveGraphql}=await import("@ai-outfitter/app-sdk/app-graphql");
  const {documents}=await import("../src/documents/documents");
  const {writeAppUpdate}=await import("@ai-outfitter/app-sdk/daily-update");
  const {reportPeriodForDate}=await import("@ai-outfitter/app-sdk/daily-period");
  const {parse,print}=await import("graphql");
  const execute=(query:string,variables:Record<string,unknown>,operation:"query"|"mutation"="query")=>
   serveGraphql({schema:graphqlSchema,query,variables,context:{database:db,identity:who},operation});
  const host={call:async(op:string,request:any)=>{
   if(op==="inference.generate")return {output:{summary:"Saved the revised design."}};
   assert.equal(request.template,"wiki-map");
   if(request.action==="graph.mutate")assert.equal(print(parse(request.input.query)),print(parse(documents.SaveGeneratedDocument.document as string)));
   return execute(request.input.query,request.input.variables,request.action==="graph.mutate"?"mutation":"query");
  }} as never;
  const period=reportPeriodForDate("2026-11-18","Asia/Tokyo");
  const record=()=>Promise.resolve({rows:[{revision:3}],complete:true});
  await writeAppUpdate(host,{...who,installationId:"workshop"},"Workshop",period,"one",record);
  await writeAppUpdate(host,{...who,installationId:"workshop"},"Workshop",period,"retry",record);
  await writeAppUpdate(host,{...who,installationId:"onto"},"Onto",period,"two",async()=>{throw new Error("Source unavailable");});
  const query=documents.DailyAppUpdates.document as string;
  const read=async(date:string,after?:string)=>{
   const answer=await execute(query,{date,first:1,...(after?{after}:{})});
   assert.equal(answer.errors,undefined,JSON.stringify(answer));
   return answer.data!.dailyAppUpdates as {nodes:{id:string;slug:string;revision:number;summary:string;app:string;complete:boolean;timezone:string}[];pageInfo:{endCursor:string;hasNextPage:boolean}};
  };
  const first=await read(period.date);
  assert.ok(first.pageInfo.hasNextPage);
  const second=await read(period.date,first.pageInfo.endCursor);
  assert.equal(second.pageInfo.hasNextPage,false);
  const rows=[...first.nodes,...second.nodes];
  assert.deepEqual(rows.map(row=>[row.app,row.revision,row.complete,row.timezone]).sort(),[["Onto",1,false,"Asia/Tokyo"],["Workshop",1,true,"Asia/Tokyo"]]);
  assert.equal(rows.find(row=>row.app==="Workshop")?.summary,"Saved the revised design.");
  assert.deepEqual((await read("2026-11-17")).nodes,[]);
  await archiveDocument(db,who,{id:first.nodes[0].id,revision:1});
  assert.deepEqual((await read(period.date)).nodes,second.nodes);
 }finally{sqlite.close();}
});

test("documentVersion reads an existing personal brief, skips archived pages and scopes its provenance",async()=>{
 const {sqlite,db}=fixture();
 try {
  for(const [date,member] of [["2026-11-18","member"],["2026-11-19","member"],["2026-11-20","other"]]){
   const doc=await saveGeneratedDocument(db,who,{title:"Daily brief",slug:"forerunner-brief-"+date+"-key",generatedBody:"Saved "+date,
    provenance:{kind:"forerunner.daily-brief",owner:{kind:"user",id:member},date,timezone:"America/Chicago",status:"complete"}});
   if(date==="2026-11-19")await archiveDocument(db,who,{id:doc.id,revision:doc.revision});
  }
  const result=await graphql({schema:graphqlSchema,source:'{documentVersion(key:"forerunner.daily-brief"){date:version markdown:generatedBody revision}}',contextValue:{identity:who,database:db}});
  assert.equal(result.errors,undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)),{documentVersion:{date:"2026-11-18",markdown:"Saved 2026-11-18",revision:1}});
 }finally{sqlite.close();}
});

test("document series select the latest edition and revision independently",async()=>{
 const {sqlite,db}=fixture();try{
  const publish=async(version:string)=>saveGeneratedDocument(db,who,{title:"Workshop catalog",slug:"parts-"+version,generatedBody:"Original",provenance:{kind:"workshop.catalog",version}});
  const first=await publish("001");await publish("002");
  await saveGeneratedDocument(db,who,{id:first.id,revision:1,generatedBody:"Corrected",provenance:{kind:"workshop.catalog",version:"001"}});
  const read=async(args:string)=>{
   const result=await graphql({schema:graphqlSchema,source:'{documentVersion(key:"workshop.catalog"'+args+'){version revision generatedBody}}',contextValue:{identity:who,database:db}});
   assert.equal(result.errors,undefined);return JSON.parse(JSON.stringify(result.data)).documentVersion;
  };
  assert.deepEqual(await read(""),{version:"002",revision:1,generatedBody:"Original"});
  assert.deepEqual(await read(',version:"001"'),{version:"001",revision:2,generatedBody:"Corrected"});
  assert.deepEqual(await read(',version:"001",revision:1'),{version:"001",revision:1,generatedBody:"Original"});
  assert.equal(await read(',version:"001",revision:3'),null);
 }finally{sqlite.close();}
});

test("WikiDocuments batches search phrases and slug or ID reads at a pinned revision",async()=>{
 const {sqlite,db}=fixture();try{
  const a=await saveDocument(db,who,{title:"Launch",slug:"launch-notes",body:"Public preview"});
  const b=await saveDocument(db,who,{title:"Model",slug:"mount",body:"New bracket"});
  await saveDocument(db,who,{id:"launch-notes",revision:1,title:"Launch",body:"Release"});
  const {documents}=await import("../src/documents/documents");
  async function read(variables:Record<string,unknown>){
   const result=await graphql({schema:graphqlSchema,source:String(documents.WikiDocuments.document),variableValues:variables,contextValue:{identity:who,database:db}});
   assert.equal(result.errors,undefined);return JSON.parse(JSON.stringify(result.data)).searchDocuments;
  }
  const matches=await read({search:["RELEASE","bracket"]});
  assert.deepEqual(matches.documents.map((r:{slug:string})=>r.slug).sort(),["launch-notes","mount"]);
  const pinned=await read({refs:[b.id,"launch-notes",a.id],revision:1,includeBody:true,first:1});
  assert.ok(pinned.next);const more=await read({refs:[b.id,"launch-notes"],revision:1,includeBody:true,after:pinned.next});
  assert.deepEqual([...pinned.documents,...more.documents].map(r=>r.body).sort(),["New bracket","Public preview"]);
  assert.equal(more.next,null);
 }finally{sqlite.close();}
});

test("page file migration restores the shared storage index after the legacy graph cutover", () => {
 const db = new DatabaseSync(":memory:");
 try {
  for (const table of ["graph_assets", "app_storage_objects"]) {
   db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY)`);
   for (const op of ["INSERT", "UPDATE", "DELETE"]) {
    db.exec(`CREATE TRIGGER _onto_cutover_${table}_${op} BEFORE ${op} ON ${table}
             BEGIN SELECT RAISE(ABORT,'Wiki graph migrated to Onto'); END`);
   }
  }
  assert.throws(() => db.exec("INSERT INTO app_storage_objects VALUES (1)"), /graph migrated/);
  db.exec(readFileSync(new URL("../migrations/0015_page_file_storage.sql", import.meta.url), "utf8"));
  db.exec("INSERT INTO app_storage_objects VALUES (1); UPDATE app_storage_objects SET id=2; DELETE FROM app_storage_objects");
  assert.throws(() => db.exec("INSERT INTO graph_assets VALUES (1)"), /graph migrated/);
 } finally { db.close(); }
});

test('install time does not require a cutover but edited seed definitions do',async()=>{
 const unavailable=workflowHost<"interactive">({props:{workflowHost:{async call(){throw new Error("Onto receipt required");}}}});
 for(const at of [1000,2000]){
  const {sqlite,db}=fixture(true,false,at);
  try{
   await requireGraphCutover(db,who,unavailable);
   sqlite.exec("UPDATE graph_types SET body='authored change' WHERE updatedBy='migration:product-documentation'");
   await assert.rejects(requireGraphCutover(db,who,unavailable),/Onto receipt required/);
  } finally {sqlite.close();}
 }
});

test("Wiki revision activity pages both stores, deduplicates cutover copies, and excludes generated digests", async () => {
  const { db, sqlite } = fixture();
  try {
    const { documents } = await import("../src/documents/documents");
    const { serveGraphql } = await import("@ai-outfitter/app-sdk/app-graphql");
    const day = Date.parse("2026-11-24T06:00:00.000Z");
    sqlite.prepare("INSERT INTO wiki_documents(id,revision,createdAt,updatedAt) VALUES('authored',1,?,?)").run(day, day);
    sqlite.prepare("INSERT INTO wiki_document_revisions(documentId,revision,title,createdAt) VALUES('authored',1,'Author draft',?)").run(day);
    sqlite.prepare("INSERT INTO wiki_pages(id,slug,documentId,updatedAt) VALUES('native-page','native-page','authored',?)").run(day);
    sqlite.prepare("INSERT INTO graph_nodes(id,typeId,slug,title,revision,createdAt,updatedAt) VALUES('late-legacy',(SELECT id FROM graph_types WHERE name='Document'),'older-page','Head',1,?,?)").run(day, day);
    sqlite.prepare("INSERT INTO graph_revisions(kind,recordId,revision,proposedBy,approval,evidence,snapshot,createdAt) VALUES('graph-node','late-legacy',1,'member','{}','[]','{\"title\":\"Ledger draft\"}',?)").run(day);
    // An imported copy of a graph ledger revision is reported only once.
    sqlite.prepare("INSERT INTO graph_revisions(kind,recordId,revision,proposedBy,approval,evidence,snapshot,createdAt) VALUES('graph-node','legacy',3,'member','{}','[]','{\"title\":\"Copied draft\"}',?)").run(day);
    sqlite.prepare("INSERT INTO wiki_document_revisions(documentId,revision,title,createdAt) VALUES('legacy',3,'Copied draft',?)").run(day);
    sqlite.prepare("INSERT INTO wiki_documents(id,revision,createdAt,updatedAt) VALUES('digest',1,?,?)").run(day, day);
    sqlite.prepare("INSERT INTO wiki_document_revisions(documentId,revision,title,provenance,createdAt) VALUES('digest',1,'Not activity','{\"kind\":\"planning.daily-report\"}',?)").run(day);
    async function read(start: string, end: string, after?: string) {
      const answer = await serveGraphql({ schema: graphqlSchema, query: documents.WikiRevisionActivity.document as string,
        variables: { start, end, first: 2, ...(after ? { after } : {}) }, context: { database: db, identity: who }, operation: "query" });
      assert.equal(answer.errors, undefined, JSON.stringify(answer.errors));
      return answer.data!.wikiRevisionActivity as { nodes: { id: string; title: string; store: string }[]; pageInfo: { endCursor: string; hasNextPage: boolean } };
    }
    const start = "2026-11-24T06:00:00.000Z", end = "2026-11-25T06:00:00.000Z";
    const first = await read(start, end), second = await read(start, end, first.pageInfo.endCursor);
    assert.ok(first.pageInfo.hasNextPage);
    assert.equal(second.pageInfo.hasNextPage, false);
    assert.deepEqual([...first.nodes, ...second.nodes].map(row => [row.id, row.title, row.store]), [
      ["authored", "Author draft", "document"], ["late-legacy", "Ledger draft", "legacy"], ["legacy", "Copied draft", "document"],
    ]);
    assert.deepEqual((await read(end, "2026-11-26T06:00:00.000Z")).nodes, []);
    sqlite.prepare("INSERT INTO wiki_documents(id,revision,archived,legacyNodeId,createdAt,updatedAt) VALUES('stored-copy',1,1,'late-legacy',?,?)").run(day, day);
    assert.deepEqual((await read(start, end)).nodes.map(row => row.id), ["authored", "legacy"]);
  } finally { sqlite.close(); }
});

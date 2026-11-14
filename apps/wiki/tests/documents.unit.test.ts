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
function fixture(withImportRevision=true) {
 const sqlite=new DatabaseSync(":memory:"); sqlite.exec("PRAGMA foreign_keys=ON");
 const folder=new URL("../migrations/",import.meta.url);
 for(const name of readdirSync(folder).filter(n=>n.endsWith('.sql') && !n.startsWith('0012') && !n.startsWith('0013')).sort()) sqlite.exec(readFileSync(new URL(name,folder),'utf8'));
 sqlite.exec(`INSERT INTO graph_nodes(id,typeId,slug,title,body,revision,createdAt,updatedAt) VALUES('legacy',(SELECT id FROM graph_types WHERE name='Document'),'old-page','Original','Original body',2,1,2);
 INSERT INTO graph_revisions(kind,recordId,revision,proposedBy,approval,evidence,snapshot,createdAt) VALUES('graph-node','legacy',1,'member','{}','[]','{"title":"First","body":"First body"}',1);`);
 sqlite.exec(readFileSync(new URL('0012_documents.sql',folder),'utf8'));
 if(withImportRevision) sqlite.exec(readFileSync(new URL('0013_imported_revision.sql',folder),'utf8'));
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

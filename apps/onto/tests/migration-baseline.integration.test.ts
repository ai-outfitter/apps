import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createClient } from "@libsql/client";
import { migrateAppDatabase, type AppDatabaseExecutor, type AppMigrationBaseline } from "@ai-outfitter/app-sdk/migrations";
const root=new URL("../",import.meta.url);
async function input() {
  const files=(await readdir(new URL("migrations/",root))).filter(n=>n.endsWith(".sql")).sort();
  const migrations=await Promise.all(files.map(async f=>({name:f.slice(0,-4),sql:await readFile(new URL(`migrations/${f}`,root),"utf8")})));
  const config=JSON.parse(await readFile(new URL("migration-baseline.json",root),"utf8"));
  const baselines:AppMigrationBaseline[]=await Promise.all(config.baselines.map(async (entry:any)=>({name:entry.name,replaces:entry.replaces,sql:await readFile(new URL(entry.file,root),"utf8")})));
  return {migrations,baselines};
}
function setup() {const client=createClient({url:"file::memory:"});const db:AppDatabaseExecutor={query:async sql=>(await client.execute(sql)).rows as unknown as Record<string,unknown>[],batch:async statements=>{await client.batch(statements,"write");}};return {client,db};}
const schema=async(db:AppDatabaseExecutor)=>db.query("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> '_outfitter_migrations' ORDER BY type,name");
test("Onto fresh baseline equals complete legacy schema and has no seeded rows",async t=>{
  const {migrations,baselines}=await input();const fresh=setup(),legacy=setup();t.after(()=>{fresh.client.close();legacy.client.close();});
  await migrateAppDatabase(legacy.db,migrations);
  assert.deepEqual(await migrateAppDatabase(fresh.db,migrations,baselines),[baselines[0].name]);
  assert.deepEqual(await schema(fresh.db),await schema(legacy.db));
  for(const row of await fresh.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_outfitter_migrations'")) assert.equal((await fresh.db.query(`SELECT count(*) AS n FROM "${row.name}"`))[0].n,0,`${row.name} must contain no seed data`);
  assert.deepEqual(await migrateAppDatabase(fresh.db,migrations,baselines),[]);
});
test("existing full and partial Onto lineages preserve graph IDs, authored text, refs, revision and batch history",async t=>{
  const {migrations,baselines}=await input();
  for(const cut of [12,migrations.length]) {
    const {db,client}=setup();t.after(()=>client.close());await migrateAppDatabase(db,migrations.slice(0,cut));
    await db.batch(["UPDATE graph_types SET title='Authored organization',revision=42 WHERE id='71000000-0000-4000-8000-000000000001'", "INSERT INTO graph_change_receipts VALUES('member:stable','doc','request','fingerprint','claim','{\"id\":\"stable-record\"}',123)"]);
    await db.batch([
      `INSERT INTO graph_nodes(id,typeId,slug,title,body,source,revision,createdAt,updatedAt) VALUES('node-stable','71000000-0000-4000-8000-000000000001','authored','Authored','Preserved text','{"installationId":"source-stable","type":"Project","id":"external-stable"}',7,1,2)`,
      `INSERT INTO graph_batches(id,title,policy,state,openedBy,openedVia,createdAt,updatedAt,expiresAt) VALUES('batch-stable','Historic batch','{"kind":"member"}','committed','member-stable','oauth-client-stable',1,2,100)`,
      `INSERT INTO graph_revisions(kind,recordId,revision,batchId,proposedBy,approval,evidence,snapshot,createdAt) VALUES('graph-node','node-stable',7,'batch-stable','agent-stable','{"member":"member-stable"}','[{"provider":"github","recordId":"issue-stable"}]','{"title":"Authored"}',2)`,
      `INSERT INTO wiki_map_proposals(id,installationId,ownerId,threadId,requestKey,payloadDigest,action,status,data,receipt) VALUES('proposal-stable','installation-stable','owner-stable','thread-stable','request-stable','digest-stable','graph.apply','applied','{}','{"id":"node-stable","confirmedBy":"member-stable"}')`,
    ]);
    const retainedQueries=["SELECT * FROM graph_nodes ORDER BY id","SELECT id,title,policy,state,openedBy,openedVia,createdAt,updatedAt,expiresAt FROM graph_batches ORDER BY id","SELECT * FROM graph_revisions ORDER BY recordId","SELECT * FROM wiki_map_proposals ORDER BY id"];
    const retained=await Promise.all(retainedQueries.map(q=>db.query(q)));
    const previous=await db.query("SELECT * FROM graph_types ORDER BY id");
    const receipts=await db.query("SELECT * FROM graph_change_receipts");
    await migrateAppDatabase(db,migrations,baselines);
    assert.deepEqual(await db.query("SELECT * FROM graph_types ORDER BY id"),previous);
    assert.deepEqual(await db.query("SELECT * FROM graph_change_receipts"),receipts);
    assert.deepEqual(await Promise.all(retainedQueries.map(q=>db.query(q))),retained);
    assert.deepEqual(await db.query(`SELECT name FROM _outfitter_migrations WHERE name='${baselines[0].name}'`),[]);
    assert.deepEqual(await migrateAppDatabase(db,migrations,baselines),[]);
  }
});

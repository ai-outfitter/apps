import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { migrateAppDatabase, type AppDatabaseExecutor } from "../src/migrations";
function setup() {
  const client=createClient({url:"file::memory:"});
  const db:AppDatabaseExecutor={query:async sql=>(await client.execute(sql)).rows as unknown as Record<string,unknown>[],batch:async statements=>{await client.batch(statements,"write");}};
  return {client,db};
}
const legacy=[{name:"0000_create",sql:"CREATE TABLE records(id TEXT PRIMARY KEY, title TEXT NOT NULL);--> statement-breakpoint\nINSERT INTO records VALUES('stable-id','seed')"},{name:"0001_revision",sql:"ALTER TABLE records ADD COLUMN revision INTEGER NOT NULL DEFAULT 1"}];
const baseline={name:"0000_fresh_v1",replaces:legacy.map(m=>m.name),sql:"CREATE TABLE records(id TEXT PRIMARY KEY,title TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1)"};
const future={name:"0002_history",sql:"CREATE TABLE history(id TEXT PRIMARY KEY)"};
test("fresh baseline installs no seeds, atomically covers ledger, applies future and retries as no-op",async t=>{
  const {client,db}=setup();t.after(()=>client.close());
  assert.deepEqual(await migrateAppDatabase(db,[...legacy,future],[baseline]),[baseline.name,future.name]);
  assert.deepEqual(await db.query("SELECT * FROM records"),[]);
  assert.equal((await db.query("SELECT count(*) AS n FROM _outfitter_migrations"))[0].n,4);
  assert.deepEqual(await migrateAppDatabase(db,[...legacy,future],[baseline]),[]);
});
test("fully legacy and partially applied ledgers continue original SQL and preserve IDs and authored rows",async t=>{
  for(const count of [1,2]) {
    const {client,db}=setup();t.after(()=>client.close());
    await migrateAppDatabase(db,legacy.slice(0,count));
    await db.batch(["UPDATE records SET title='authored' WHERE id='stable-id'"]);
    await migrateAppDatabase(db,[...legacy,future],[baseline]);
    assert.deepEqual((await db.query("SELECT * FROM records"))[0],{id:"stable-id",title:"authored",revision:1});
    assert.deepEqual(await db.query(`SELECT * FROM _outfitter_migrations WHERE name='${baseline.name}'`),[]);
    assert.deepEqual(await migrateAppDatabase(db,[...legacy,future],[baseline]),[]);
  }
});
test("baseline failure rolls back schema and every replacement ledger row",async t=>{
  const {client,db}=setup();t.after(()=>client.close());
  await assert.rejects(migrateAppDatabase(db,legacy,[{...baseline,sql:baseline.sql+";--> statement-breakpoint\nINSERT INTO absent VALUES(1)"}]));
  assert.deepEqual(await db.query("SELECT * FROM _outfitter_migrations"),[]);
  assert.deepEqual(await db.query("SELECT name FROM sqlite_master WHERE name='records'"),[]);
  assert.deepEqual(await migrateAppDatabase(db,legacy,[baseline]),[baseline.name]);
});
test("duplicate, unknown and conflicting lineage fails before SQL",async t=>{
  const {client,db}=setup();t.after(()=>client.close());
  for(const [migrations,baselines] of [
    [[...legacy,legacy[0]],[baseline]],
    [legacy,[{...baseline,replaces:[legacy[0].name,legacy[0].name]}]],
    [legacy,[{...baseline,replaces:["9999_unknown"]}]],
    [legacy,[{...baseline,name:legacy[0].name}]],
    [legacy,[baseline,{...baseline,name:"0000_other"}]],
  ] as const) await assert.rejects(migrateAppDatabase(db,[...migrations],[...baselines]));
  assert.deepEqual(await db.query("SELECT name FROM sqlite_master WHERE type='table'"),[]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { readOrder, saveOrder, sortByOrder } from "../src/server/priority-order";

test("organization orders are isolated, complete, revision checked and editor controlled",async()=>{
 const client=createClient({url:":memory:"});
 try {
  const db=drizzle(client); await migrate(db,{migrationsFolder:fileURLToPath(new URL("../migrations",import.meta.url))});
  const a={installationId:"a",organizationId:"org-a",canEdit:true,userId:"a"} as any;
  const b={...a,installationId:"b",organizationId:"org-b"};
  const ids=["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"];
  assert.deepEqual(await readOrder(db,a,"products"),{items:[],revision:0});
  await saveOrder(db,a,{kind:"products",items:ids,revision:0},ids);
  assert.deepEqual(await readOrder(db,b,"products"),{items:[],revision:0});
  await assert.rejects(saveOrder(db,a,{kind:"products",items:ids,revision:0},ids),(error:unknown)=>error instanceof Response && error.status===409);
  await assert.rejects(saveOrder(db,a,{kind:"products",items:ids.slice(0,1),revision:1},ids),(error:unknown)=>error instanceof Response && error.status===409);
  await assert.rejects(saveOrder(db,{...a,canEdit:false},{kind:"products",items:ids,revision:1},ids),(error:unknown)=>error instanceof Response && error.status===403);
  await saveOrder(db,a,{kind:"products",items:ids.toReversed(),revision:1},ids);
  assert.deepEqual(sortByOrder(ids,(await readOrder(db,a,"products")).items,x=>x),ids.toReversed());
  assert.deepEqual(await readOrder(db,a,"projects"),{items:[],revision:0});
 } finally {client.close()}
});

import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { core } from "../src/lib/graph";
const org = { userId: "platform-installer", organizationId: "tenant-a", role: "owner", owner: { kind: "organization" as const, id: "tenant-a" } };
const personal = { userId: "platform-installer", organizationId: "", role: "owner", owner: { kind: "user" as const, id: "actual-owner" } };
const accountType = "71000000-0000-4000-8000-000000000120";
async function json(response: Response): Promise<any> { assert.equal(response.status, 200, await response.clone().text()); return response.json(); }
async function fixture(who: typeof org | typeof personal = org) {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "owner-root");
  const init = () => app.call("/api/internal/app-initialize", who, { method: "POST", body: {} });
  const action = (action: string, input: object, identity = who) => app.call("/api/internal/actions/v1/call", identity, { method: "POST", body: { action, input } });
  const query = async (query: string, identity = who) => json(await action(query.startsWith("query") ? "graph.graphql" : "graph.mutate", { query }, identity));
  return { app, init, query, action };
}
test("organization setup uses host owner, preserves authored root and repeats without writes", async t => {
  const f = await fixture(); t.after(() => f.app.dispose());
  const result = await json(await f.init()); assert.equal(result.ownerRoot.status, "ready"); assert.equal(result.ownerRoot.created,true);
  const root = await f.app.database.prepare("SELECT * FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'").first(); assert.ok(root);
  assert.equal(root.typeId,core.organization); assert.equal(root.title,"Installation owner organization");
  await f.app.database.prepare("UPDATE graph_nodes SET title='Authored',revision=revision+1 WHERE id=?").bind(root.id).run();
  const before = await f.app.database.prepare("SELECT * FROM graph_nodes WHERE id=?").bind(root.id).first();
  assert.equal((await json(await f.init())).ownerRoot.created,false);
  assert.deepEqual(await f.app.database.prepare("SELECT * FROM graph_nodes WHERE id=?").bind(root.id).first(),before);
  assert.equal((await f.query("query { ownerRoot }")).data.ownerRoot.root,result.ownerRoot.root);
});
test("personal setup creates actual owner's account; linked work commits and verified holder transition preserves path", async t => {
  const f = await fixture(personal); t.after(() => f.app.dispose());
  const result = await json(await f.init()); assert.match(result.ownerRoot.root,/^OutfitterUser:owner-/);
  const accounts = await f.app.database.prepare("SELECT id,externalKey FROM graph_nodes WHERE typeId=?").bind(accountType).all();
  assert.equal(accounts.results.length,1); assert.equal(accounts.results[0].externalKey,"ai-outfitter.com/users:actual-owner");
  const accountId = accounts.results[0].id;
  const {batch} = await json(await f.action("batch.open",{title:"Account-rooted research"}));
  await json(await f.action("batch.add",{batchId:batch.id,proposals:[
    {operation:{operation:"create",ref:"$note",type:"graph-node",attributes:{typeId:core.document,slug:"evidence",title:"Evidence"}}},
    {operation:{operation:"create",ref:"$link",type:"graph-edge",attributes:{typeId:"71000000-0000-4000-8000-000000000032",fromId:"$note",toId:result.ownerRoot.root}}}
  ]}));
  await json(await f.action("batch.submit",{batchId:batch.id}));
  const holderId = crypto.randomUUID();
  await f.app.database.prepare("INSERT INTO graph_nodes(id,typeId,slug,title,createdAt,updatedAt) VALUES(?,?,?,?,0,0)").bind(holderId,core.person,"verified-holder","Verified holder").run();
  await json(await f.app.call("/api/internal/identity/v1/link",personal,{method:"POST",body:{holderId,principalId:"actual-owner",kind:"human"}}));
  assert.equal((await f.query("query { ownerRoot }")).data.ownerRoot.root,"Person:verified-holder");
  assert.ok(await f.app.database.prepare("SELECT id FROM graph_edges WHERE fromId=? AND toId=? AND archived=0").bind(accountId,holderId).first());
  await json(await f.app.call("/api/apps/onto/batches/review",personal,{method:"POST",body:{batchId:batch.id,verdict:"approve"}}));
  assert.equal((await json(await f.init())).ownerRoot.created,false);
});
test("archives and duplicate exact organization bindings block without failing upgrade or creating replacements", async t => {
  const f=await fixture();t.after(()=>f.app.dispose());await json(await f.init());
  const root=await f.app.database.prepare("SELECT id FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'").first();
  await f.app.database.prepare("UPDATE graph_nodes SET archived=1,revision=revision+1 WHERE id=?").bind(root!.id).run();
  assert.equal((await json(await f.init())).ownerRoot.binding,"archived");
  await f.app.database.prepare("UPDATE graph_nodes SET archived=0,revision=revision+1 WHERE id=?").bind(root!.id).run();
  await f.app.database.prepare("INSERT INTO graph_nodes(id,typeId,slug,title,properties,createdAt,updatedAt) VALUES(?,?,?,?,?,0,0)").bind(crypto.randomUUID(),core.organization,"duplicate","Duplicate",JSON.stringify({organization_id:"tenant-a"})).run();
  assert.equal((await json(await f.init())).ownerRoot.binding,"ambiguous");
});
test("archived and wrong-type personal account keys block without identity guessing", async t => {
  const f=await fixture(personal);t.after(()=>f.app.dispose());await json(await f.init());
  await f.app.database.prepare("UPDATE graph_nodes SET archived=1,revision=revision+1 WHERE externalKey=?").bind("ai-outfitter.com/users:actual-owner").run();
  assert.equal((await json(await f.init())).ownerRoot.binding,"conflicting");
  await f.app.database.prepare("UPDATE graph_nodes SET archived=0,typeId=?,revision=revision+1 WHERE externalKey=?").bind(core.person,"ai-outfitter.com/users:actual-owner").run();
  assert.equal((await json(await f.init())).ownerRoot.binding,"conflicting");
});
test("editor-only concurrent reconciliation creates one root and does not adopt same-name nodes", async t => {
  const f=await fixture();t.after(()=>f.app.dispose());await json(await f.init());
  await f.app.database.prepare("DELETE FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'").run();
  await f.app.database.prepare("INSERT INTO graph_nodes(id,typeId,slug,title,createdAt,updatedAt) VALUES(?,?,?,?,0,0)").bind(crypto.randomUUID(),core.organization,"installation-owner","Installation owner organization").run();
  const query="mutation { ensureOwnerRoot }";
  assert.equal((await f.action("graph.mutate",{query},{...org,role:"member"})).status,403);
  const results=await Promise.all([f.query(query),f.query(query)]);
  for(const result of results){assert.equal(result.errors,undefined,JSON.stringify(result));assert.equal(result.data.ensureOwnerRoot.status,"ready");}
  const roots=await f.app.database.prepare("SELECT slug FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'").all();
  assert.equal(roots.results.length,1); assert.match(String(roots.results[0].slug),/^owner-/);
});
test("manual exact binding racing bootstrap wins without duplicate root", async t => {
  const f=await fixture();t.after(()=>f.app.dispose());await json(await f.init());
  const client=f.app.database;
  await client.prepare("DELETE FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'").run();
  const original=client.batch.bind(client);let injected=false;
  const proxy=new Proxy(client,{get(target,key){
    if(key==="batch")return async(statements:any[])=>{
      if(!injected){injected=true;await client.prepare("INSERT INTO graph_nodes(id,typeId,slug,title,properties,createdAt,updatedAt) VALUES(?,?,?,?,?,0,0)").bind(crypto.randomUUID(),core.organization,"authored-owner","Authored owner",JSON.stringify({organization_id:"tenant-a"})).run();}
      return original(statements);
    };
    const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
  }});
  const {drizzle}=await import("drizzle-orm/d1");const {ensureOwnerRoot}=await import("../src/server/owner-root");
  const result=await ensureOwnerRoot(drizzle(proxy),{...org,installationId:f.app.installationId,canEdit:true});
  assert.equal(injected,true);assert.equal(result.root,"Organization:authored-owner");assert.equal(result.created,false);
  assert.equal((await client.prepare("SELECT count(*) AS n FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'").first())?.n,1);
});
test("custom authored schema requiring unknown values reports actionable blocked setup without overriding it", async t => {
  const f=await fixture();t.after(()=>f.app.dispose());await json(await f.init());
  await f.app.database.prepare("DELETE FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'").run();
  const stored=await f.app.database.prepare("SELECT properties FROM graph_types WHERE id=?").bind(core.organization).first();
  const metadata=JSON.parse(String(stored!.properties)); const fields=Array.isArray(metadata)?metadata:metadata.fields;
  fields.push({name:"legal_registration",type:"string",required:true});
  await f.app.database.prepare("UPDATE graph_types SET properties=?,updatedBy='author',revision=revision+1 WHERE id=?").bind(JSON.stringify(metadata),core.organization).run();
  const result=await json(await f.init());assert.equal(result.ownerRoot.binding,"schema-conflict");assert.match(result.ownerRoot.reason,/legal_registration/);
  assert.equal((await f.app.database.prepare("SELECT count(*) AS n FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'").first())?.n,0);
});
test("active account links to invalid or multiple holders block; read-only status changes nothing", async t => {
  const f=await fixture(personal);t.after(()=>f.app.dispose());await json(await f.init());
  const account=await f.app.database.prepare("SELECT id FROM graph_nodes WHERE typeId=?").bind(accountType).first();
  const holder=crypto.randomUUID(),edge=crypto.randomUUID();
  await f.app.database.prepare("INSERT INTO graph_nodes(id,typeId,slug,title,createdAt,updatedAt) VALUES(?,?,?,?,0,0)").bind(holder,core.person,"holder","Holder").run();
  await f.app.database.prepare("INSERT INTO graph_edges(id,typeId,fromId,toId,createdAt,updatedAt) VALUES(?,?,?,?,0,0)").bind(edge,"71000000-0000-4000-8000-000000000122",account!.id,holder).run();
  await f.app.database.prepare("UPDATE graph_nodes SET archived=1,revision=revision+1 WHERE id=?").bind(holder).run();
  assert.equal((await f.query("query { ownerRoot }")).data.ownerRoot.binding,"ambiguous");
  assert.equal((await json(await f.init())).ownerRoot.binding,"ambiguous");
  assert.equal((await f.app.database.prepare("SELECT archived FROM graph_nodes WHERE id=?").bind(holder).first())?.archived,1);
});

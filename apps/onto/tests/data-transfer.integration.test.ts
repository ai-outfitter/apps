import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import type { AppArchive } from "@ai-outfitter/app-sdk/data-transfer";
import { core } from "../src/lib/graph";

const pack = new URL("../.outfitter/packages/operational.json", import.meta.url);
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const prodId = "91000000-0000-4000-8000-0000000000a1";
const localId = "91000000-0000-4000-8000-0000000000b1";
const node = { id: "91000000-0000-4000-8000-000000000001", typeId: core.organization, slug: "archive-org", title: "Archive Org" };

async function exportAll(app: Awaited<ReturnType<typeof appWorker>>, who = owner) {
  const pages: AppArchive[] = [];
  let cursor: string | null = null;
  do {
    const response = await app.call(`/api/outfitter/data/export${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, who);
    assert.equal(response.status, 200, await response.clone().text());
    const page = await response.json() as AppArchive;
    pages.push(page);
    cursor = page.cursor;
  } while (cursor);
  return pages;
}

async function pull(local: Awaited<ReturnType<typeof appWorker>>, pages: AppArchive[], who = owner) {
  const map = { [prodId]: localId };
  for (const archive of pages) {
    const preview = await local.call("/api/outfitter/data/preview", who, { method: "POST", body: { archive, map } });
    assert.equal(preview.status, 200, await preview.clone().text());
    const { previewToken } = await preview.json() as { previewToken: string };
    const imported = await local.call("/api/outfitter/data/import", who, { method: "POST", body: { archive, map, previewToken } });
    assert.equal(imported.status, 200, await imported.clone().text());
  }
}

test("a Wiki archive pulls into another installation and later pulls carry prod edits", async () => {
  const prod = await appWorker("onto", pack, prodId);
  const local = await appWorker("onto", pack, localId);
  try {
    for (const app of [prod, local])
      assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
    // Seed one prod record through the existing Wiki import.
    const transfer = { format: "outfitter-wiki-transfer-v1", types: [], nodes: [node], edges: [] };
    const preview = await prod.call("/api/apps/onto/graph/preview", owner, { method: "POST", body: transfer });
    const { previewToken } = await preview.json() as { previewToken: string };
    assert.equal((await prod.call("/api/apps/onto/graph/restore", owner, { method: "POST", body: { transfer, previewToken } })).status, 200);

    assert.equal((await local.call("/api/outfitter/data/export", { ...owner, role: "member" })).status, 403);
    await pull(local, await exportAll(prod));
    const snapshot = async () => (await (await local.call("/api/apps/onto/graph/snapshot", owner)).json()) as { nodes: { id: string; title: string }[] };
    assert.equal((await snapshot()).nodes.find((n) => n.id === node.id)?.title, "Archive Org");

    // Edit in prod through the ordinary entity API, then pull again.
    const updated = await prod.call("/api/apps/onto/graph/update", owner, { method: "POST", body: { type: "graph-node", id: node.id, revision: 1, attributes: { title: "Renamed in prod" } } });
    assert.equal(updated.status, 200, await updated.clone().text());
    await pull(local, await exportAll(prod));
    assert.equal((await snapshot()).nodes.find((n) => n.id === node.id)?.title, "Renamed in prod");
  } finally {
    await prod.dispose();
    await local.dispose();
  }
});

test("personal account roots survive same-owner portable copies; foreign account context cannot replace destination root", async () => {
  const me={...owner,organizationId:"",owner:{kind:"user" as const,id:"owner"}}; const other={...me,userId:"other-owner",owner:{kind:"user" as const,id:"other-owner"}};
  const prod=await appWorker("onto",pack,prodId),local=await appWorker("onto",pack,localId);
  try {
    for(const app of [prod,local])assert.equal((await app.call("/api/internal/app-initialize",me,{method:"POST",body:{}})).status,200);
    const root=async(app:typeof prod,key:string)=>app.database.prepare("SELECT id,slug,externalKey FROM graph_nodes WHERE externalKey=?").bind(key).first();
    const source=await root(prod,"ai-outfitter.com/users:owner");
    assert.deepEqual(await root(local,"ai-outfitter.com/users:owner"),source);
    await pull(local,await exportAll(prod,me),me);
    assert.deepEqual(await root(local,"ai-outfitter.com/users:owner"),source);
    // A separately owned destination can retain foreign account context without adopting it.
    const foreign=await appWorker("onto",pack,localId);
    try {
      assert.equal((await foreign.call("/api/internal/app-initialize",other,{method:"POST",body:{}})).status,200);
      const before=await root(foreign,"ai-outfitter.com/users:other-owner");assert.notEqual(before!.id,source!.id);
      await pull(foreign,await exportAll(prod,me),other);
      assert.deepEqual(await root(foreign,"ai-outfitter.com/users:other-owner"),before);
      const status=await foreign.call("/api/internal/actions/v1/call",other,{method:"POST",body:{action:"graph.graphql",input:{query:"query { ownerRoot }"}}});
      assert.equal((await status.json() as any).data.ownerRoot.root,`OutfitterUser:${before!.slug}`);
    } finally {await foreign.dispose();}
  } finally {await prod.dispose();await local.dispose();}
});

test("legacy authored owner IDs require explicit archive mapping; import never silently duplicates or merges roots", async () => {
  for(const personal of [false,true]) {
    const who=personal?{...owner,organizationId:"",owner:{kind:"user" as const,id:"owner"}}:owner;
    const prod=await appWorker("onto",pack,prodId),local=await appWorker("onto",pack,localId);
    try {
      for(const app of [prod,local])assert.equal((await app.call("/api/internal/app-initialize",who,{method:"POST",body:{}})).status,200);
      const predicate=personal?"externalKey='ai-outfitter.com/users:owner'":"json_extract(properties,'$.organization_id')='org'";
      const source=await prod.database.prepare(`SELECT id FROM graph_nodes WHERE ${predicate}`).first();
      const destination=await local.database.prepare(`SELECT id FROM graph_nodes WHERE ${predicate}`).first();
      const legacy=crypto.randomUUID();
      // Represents a previously authored canonical record, before automatic bootstrap shipped.
      await prod.database.prepare("UPDATE graph_nodes SET id=?,slug='authored-owner',title='Authored owner',revision=2 WHERE id=?").bind(legacy,source!.id).run();
      const evidenceId=crypto.randomUUID(), edgeId=crypto.randomUUID();
      await prod.database.prepare("INSERT INTO graph_nodes(id,typeId,slug,title,createdAt,updatedAt) VALUES(?,?,?,?,0,0)").bind(evidenceId,core.document,"owner-evidence","Owner evidence").run();
      await prod.database.prepare("INSERT INTO graph_edges(id,typeId,fromId,toId,createdAt,updatedAt) VALUES(?,?,?,?,0,0)").bind(edgeId,"71000000-0000-4000-8000-000000000032",evidenceId,legacy).run();
      const pages=await exportAll(prod,who);let refused=false;
      for(const archive of pages){
        const response=await local.call("/api/outfitter/data/preview",who,{method:"POST",body:{archive,map:{[prodId]:localId}}});
        if(response.status===409){refused=true;assert.match(await response.text(),personal?/unique|conflict|externalKey/i:/ambiguous organization owner bindings/i);break;}
        assert.equal(response.status,200,await response.clone().text());
      }
      assert.equal(refused,true,"incompatible roots require explicit reconciliation");
      // Existing archive remapping is an explicit caller decision, never inferred from titles.
      for(const archive of pages){
        const map={[prodId]:localId,[legacy]:String(destination!.id)};
        const preview=await local.call("/api/outfitter/data/preview",who,{method:"POST",body:{archive,map}});
        assert.equal(preview.status,200,await preview.clone().text());
        const {previewToken}=await preview.json() as {previewToken:string};
        const response=await local.call("/api/outfitter/data/import",who,{method:"POST",body:{archive,map,previewToken}});
        assert.equal(response.status,200,await response.clone().text());
      }
      assert.equal((await local.database.prepare(`SELECT count(*) AS n FROM graph_nodes WHERE ${predicate}`).first())?.n,1);
      assert.equal((await local.database.prepare(`SELECT id FROM graph_nodes WHERE ${predicate}`).first())?.id,destination!.id);
      assert.equal((await local.database.prepare("SELECT toId FROM graph_edges WHERE id=?").bind(edgeId).first())?.toId,destination!.id);
    }finally{await prod.dispose();await local.dispose();}
  }
});

test("whole-app archive rolls back when a root binding changes after validation", async () => {
  const prod=await appWorker("onto",pack,prodId),local=await appWorker("onto",pack,localId);
  try {
    for(const app of [prod,local])assert.equal((await app.call("/api/internal/app-initialize",owner,{method:"POST",body:{}})).status,200);
    const doc=crypto.randomUUID();
    await prod.database.prepare("INSERT INTO graph_nodes(id,typeId,slug,title,createdAt,updatedAt) VALUES(?,?,?,?,0,0)").bind(doc,core.document,"race-evidence","Race evidence").run();
    const archive=(await exportAll(prod)).find(page=>{
      const table=page.tables.graph_nodes;return table?.rows.some(row=>row[table.columns.indexOf("id")]===doc);
    });assert.ok(archive);
    const map={[prodId]:localId};
    const preview=await local.call("/api/outfitter/data/preview",owner,{method:"POST",body:{archive,map}});
    assert.equal(preview.status,200,await preview.clone().text());
    const {previewToken}=await preview.json() as {previewToken:string};
    const {drizzle}=await import("drizzle-orm/d1");
    const {readGraph}=await import("../src/server/graph");
    const {guardedArchive}=await import("../src/server/guarded-archive");
    const {applyImport}=await import("@ai-outfitter/app-sdk/data-transfer");
    const {archiveImportExclusions}=await import("../src/server/archive-authorities");
    const client=local.database;let injected=false;
    const who={...owner,owner:{kind:"organization" as const,id:"org"},installationId:localId,canEdit:true};
    const guarded=guardedArchive({
      async query(statement){return (await client.prepare(statement.sql).bind(...(statement.params??[])).all()).results;},
      async batch(statements){
        injected=true;
        await client.prepare("INSERT INTO graph_nodes(id,typeId,slug,title,properties,createdAt,updatedAt) VALUES(?,?,?,?,?,0,0)").bind(crypto.randomUUID(),core.organization,"racing-owner","Racing owner",JSON.stringify({organization_id:"org"})).run();
        return client.batch(statements.map(statement=>client.prepare(statement.sql).bind(...(statement.params??[]))));
      }
    },()=>readGraph(drizzle(client),who),who);
    await assert.rejects(applyImport(guarded.database,who,{archive,map,previewToken},{exclude:[...archiveImportExclusions],validate:guarded.validate}),e=>e instanceof Response&&e.status===409);
    assert.equal(injected,true);
    assert.equal(await client.prepare("SELECT id FROM graph_nodes WHERE id=?").bind(doc).first(),null);
    assert.equal((await client.prepare("SELECT count(*) AS n FROM graph_changes WHERE requestKey LIKE 'archive-snapshot:%'").first())?.n,0);
  } finally {await prod.dispose();await local.dispose();}
});

import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { core } from "../src/lib/graph";
const org = {
  userId: "platform-installer",
  organizationId: "tenant-a",
  role: "owner",
  owner: { kind: "organization" as const, id: "tenant-a" },
};
const personal = {
  userId: "platform-installer",
  organizationId: "",
  role: "owner",
  owner: { kind: "user" as const, id: "actual-owner" },
};
const accountType = "71000000-0000-4000-8000-000000000120";
async function json(response: Response): Promise<any> {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function fixture(who: typeof org | typeof personal = org) {
  const app = await appWorker(
    "onto",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "owner-root",
  );
  const init = () =>
    app.call("/api/internal/app-initialize", who, { method: "POST", body: {} });
  const action = (action: string, input: object) =>
    app.call("/api/internal/actions/v1/call", who, {
      method: "POST",
      body: { action, input },
    });
  const open = async () =>
    (await json(await action("batch.open", { title: "Root check" }))).batch;
  return { app, init, action, open };
}
test("organization upgrade creates trusted owner once and preserves authored root content", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  assert.equal((await json(await f.init())).ownerRoot.status, "created");
  const root = await f.app.database
    .prepare(
      "SELECT * FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'",
    )
    .first();
  assert.ok(root);
  assert.deepEqual((await f.open()).anchors, [root.id]);
  await f.app.database
    .prepare(
      "UPDATE graph_nodes SET title='Authored',revision=revision+1 WHERE id=?",
    )
    .bind(root.id)
    .run();
  const before = await f.app.database
    .prepare("SELECT * FROM graph_nodes WHERE id=?")
    .bind(root.id)
    .first();
  assert.equal((await json(await f.init())).ownerRoot.status, "kept");
  assert.deepEqual(
    await f.app.database
      .prepare("SELECT * FROM graph_nodes WHERE id=?")
      .bind(root.id)
      .first(),
    before,
  );
});
test("personal upgrade anchors to actual owner account and preserves later verified holder", async (t) => {
  const f = await fixture(personal);
  t.after(() => f.app.dispose());
  await json(await f.init());
  const accounts = await f.app.database
    .prepare("SELECT id,externalKey FROM graph_nodes WHERE typeId=?")
    .bind(accountType)
    .all();
  assert.equal(accounts.results.length, 1);
  assert.equal(
    accounts.results[0].externalKey,
    "ai-outfitter.com/users:actual-owner",
  );
  assert.deepEqual((await f.open()).anchors, [accounts.results[0].id]);
  const holder = crypto.randomUUID();
  await f.app.database
    .prepare(
      "INSERT INTO graph_nodes(id,typeId,slug,title,createdAt,updatedAt) VALUES(?,?,?,?,0,0)",
    )
    .bind(holder, core.person, "verified-holder", "Verified holder")
    .run();
  await json(
    await f.app.call("/api/internal/identity/v1/link", personal, {
      method: "POST",
      body: { holderId: holder, principalId: "actual-owner", kind: "human" },
    }),
  );
  assert.equal((await json(await f.init())).ownerRoot.status, "kept");
  assert.deepEqual((await f.open()).anchors, [holder]);
});
test("existing configured organization home remains the anchor without adding a replacement", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.init());
  const root = await f.app.database
    .prepare(
      "SELECT id FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'",
    )
    .first();
  await f.app.database
    .prepare(
      "UPDATE graph_nodes SET properties='{}',revision=revision+1 WHERE id=?",
    )
    .bind(root!.id)
    .run();
  let type = await f.app.database
    .prepare("SELECT id FROM graph_types WHERE name='GovernanceHomeSettings'")
    .first();
  if (!type) {
    type = { id: crypto.randomUUID() };
    await f.app.database
      .prepare(
        "INSERT INTO graph_types(id,category,name,title,body,properties,createdAt,updatedAt) VALUES(?,'node','GovernanceHomeSettings','Home','','[]',0,0)",
      )
      .bind(type.id)
      .run();
  }
  await f.app.database
    .prepare(
      "INSERT INTO graph_nodes(id,typeId,slug,title,body,createdAt,updatedAt) VALUES(?,?,?,?,?,0,0)",
    )
    .bind(
      crypto.randomUUID(),
      type.id,
      "home",
      "Home",
      JSON.stringify({
        schema_version: 1,
        organization_root: {
          installationId: f.app.installationId,
          type: "graph-node",
          id: root!.id,
        },
      }),
    )
    .run();
  assert.equal((await json(await f.init())).ownerRoot.status, "kept");
  assert.deepEqual((await f.open()).anchors, [root!.id]);
  assert.equal(
    (
      await f.app.database
        .prepare(
          "SELECT count(*) AS n FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'",
        )
        .first()
    )?.n,
    0,
  );
});
test("archives and conflicting account identities are preserved and reported", async (t) => {
  for (const who of [org, personal]) {
    const f = await fixture(who);
    t.after(() => f.app.dispose());
    await json(await f.init());
    const condition =
      who.owner.kind === "user"
        ? "externalKey='ai-outfitter.com/users:actual-owner'"
        : "json_extract(properties,'$.organization_id')='tenant-a'";
    await f.app.database
      .prepare(
        `UPDATE graph_nodes SET archived=1,revision=revision+1 WHERE ${condition}`,
      )
      .run();
    assert.equal((await json(await f.init())).ownerRoot.status, "blocked");
    assert.equal(
      (
        await f.app.database
          .prepare(`SELECT count(*) AS n FROM graph_nodes WHERE ${condition}`)
          .first()
      )?.n,
      1,
    );
  }
});
test("same-owner initializations use stable record identities across installations", async (t) => {
  for (const who of [org, personal]) {
    const a = await fixture(who),
      b = await fixture(who);
    t.after(() => a.app.dispose());
    t.after(() => b.app.dispose());
    await json(await a.init());
    await json(await b.init());
    assert.deepEqual((await a.open()).anchors, (await b.open()).anchors);
  }
});
test("a concurrent authored root wins bootstrap without duplicates", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.init());
  const client = f.app.database;
  await client
    .prepare(
      "DELETE FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'",
    )
    .run();
  const original = client.batch.bind(client);
  let injected = false;
  const authored = crypto.randomUUID();
  const proxy = new Proxy(client, {
    get(target, key) {
      if (key === "batch")
        return async (statements: any[]) => {
          if (!injected) {
            injected = true;
            await client
              .prepare(
                "INSERT INTO graph_nodes(id,typeId,slug,title,properties,createdAt,updatedAt) VALUES(?,?,?,?,?,0,0)",
              )
              .bind(
                authored,
                core.organization,
                "authored",
                "Authored",
                JSON.stringify({ organization_id: "tenant-a" }),
              )
              .run();
          }
          return original(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { drizzle } = await import("drizzle-orm/d1");
  const { initializeOwnerRoot } = await import("../src/server/owner-root");
  assert.equal(
    (
      await initializeOwnerRoot(drizzle(proxy), {
        ...org,
        installationId: f.app.installationId,
        canEdit: true,
      })
    ).status,
    "kept",
  );
  assert.equal(injected, true);
  assert.deepEqual((await f.open()).anchors, [authored]);
});
test("custom required schema reports blocked setup without inventing values or failing upgrade", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.init());
  await f.app.database
    .prepare(
      "DELETE FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'",
    )
    .run();
  const row = await f.app.database
    .prepare("SELECT properties FROM graph_types WHERE id=?")
    .bind(core.organization)
    .first();
  const metadata = JSON.parse(String(row!.properties));
  (Array.isArray(metadata) ? metadata : metadata.fields).push({
    name: "legal_registration",
    type: "string",
    required: true,
  });
  await f.app.database
    .prepare(
      "UPDATE graph_types SET properties=?,updatedBy='author',revision=revision+1 WHERE id=?",
    )
    .bind(JSON.stringify(metadata), core.organization)
    .run();
  const result = await json(await f.init());
  assert.equal(result.ownerRoot.status, "blocked");
  assert.match(result.ownerRoot.reason, /legal_registration/);
});

test("concurrent owner setup remains idempotent", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.init());
  await f.app.database
    .prepare(
      "DELETE FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'",
    )
    .run();
  const { drizzle } = await import("drizzle-orm/d1");
  const { initializeOwnerRoot } = await import("../src/server/owner-root");
  const who = { ...org, installationId: f.app.installationId, canEdit: true };
  const results = await Promise.all([
    initializeOwnerRoot(drizzle(f.app.database), who),
    initializeOwnerRoot(drizzle(f.app.database), who),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    "created",
    "kept",
  ]);
  assert.equal(
    (
      await f.app.database
        .prepare(
          "SELECT count(*) AS n FROM graph_nodes WHERE json_extract(properties,'$.organization_id')='tenant-a'",
        )
        .first()
    )?.n,
    1,
  );
});

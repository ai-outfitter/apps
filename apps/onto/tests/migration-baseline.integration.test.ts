import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createClient } from "@libsql/client";
import {
  migrateAppDatabase,
  type AppDatabaseExecutor,
  type AppMigrationBaseline,
} from "@ai-outfitter/app-sdk/migrations";
const root = new URL("../", import.meta.url);
async function input() {
  const files = (await readdir(new URL("migrations/", root)))
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const migrations = await Promise.all(
    files.map(async (f) => ({
      name: f.slice(0, -4),
      sql: await readFile(new URL(`migrations/${f}`, root), "utf8"),
    })),
  );
  const config = JSON.parse(
    await readFile(new URL("migration-baseline.json", root), "utf8"),
  );
  const baselines: AppMigrationBaseline[] = await Promise.all(
    config.baselines.map(async (entry: any) => ({
      name: entry.name,
      replaces: entry.replaces,
      sql: await readFile(new URL(entry.file, root), "utf8"),
    })),
  );
  return { migrations, baselines };
}
function setup() {
  const client = createClient({ url: "file::memory:" });
  const db: AppDatabaseExecutor = {
    query: async (sql) =>
      (await client.execute(sql)).rows as unknown as Record<string, unknown>[],
    batch: async (statements) => {
      await client.batch(statements, "write");
    },
  };
  return { client, db };
}
const schema = async (db: AppDatabaseExecutor) =>
  db.query(
    "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> '_outfitter_migrations' ORDER BY type,name",
  );
const sourceAuthorityTables = [
  "onto_source_definitions",
  "onto_source_proofs",
  "onto_source_fences",
];
async function assertSourceAuthorityTables(db: AppDatabaseExecutor) {
  const tables = await db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'onto_source_%' ORDER BY name",
  );
  assert.deepEqual(
    tables,
    sourceAuthorityTables.toSorted().map((name) => ({ name })),
  );
  for (const table of sourceAuthorityTables) {
    const columns = await db.query(`PRAGMA table_info(${table})`);
    assert.ok(
      columns.some((column) => column.name === "owner" && column.pk === 1),
      `${table} retains the owner-bound primary key`,
    );
    assert.ok(
      columns.some(
        (column) =>
          column.name ===
            (table === "onto_source_fences" ? "idempotency_key" : "id") &&
          column.pk === 2,
      ),
    );
  }
}
test("Onto frozen baseline plus normal migration tail equals legacy schema without seeded rows", async (t) => {
  const { migrations, baselines } = await input();
  const fresh = setup(),
    freshAll = setup(),
    legacy = setup();
  t.after(() => {
    fresh.client.close();
    freshAll.client.close();
    legacy.client.close();
  });
  const baseline = baselines[0];
  const covered = migrations.filter((migration) =>
    baseline.replaces.includes(migration.name),
  );
  const tail = migrations.filter(
    (migration) => !baseline.replaces.includes(migration.name),
  );
  assert.equal(baseline.name, "0000_onto_schema_v1");
  assert.equal(covered.length, 16, "v1 stays frozen at the original lineage");
  assert.equal(covered.at(-1)?.name, "0014_publications");
  assert.ok(tail.some((migration) => migration.name === "0015_source_fences"));
  await migrateAppDatabase(legacy.db, covered);
  assert.deepEqual(await migrateAppDatabase(fresh.db, covered, baselines), [
    baseline.name,
  ]);
  assert.deepEqual(await schema(fresh.db), await schema(legacy.db));
  assert.deepEqual(
    await fresh.db.query(
      "SELECT name FROM sqlite_master WHERE name LIKE 'onto_source_%'",
    ),
    [],
  );
  assert.deepEqual(
    await migrateAppDatabase(fresh.db, migrations, baselines),
    tail.map((migration) => migration.name),
  );
  assert.deepEqual(
    await migrateAppDatabase(legacy.db, migrations),
    tail.map((migration) => migration.name),
  );
  assert.deepEqual(
    await fresh.db.query(
      "SELECT name FROM _outfitter_migrations ORDER BY name",
    ),
    [baseline.name, ...migrations.map((migration) => migration.name)]
      .sort()
      .map((name) => ({ name })),
  );
  assert.deepEqual(
    await migrateAppDatabase(freshAll.db, migrations, baselines),
    [baseline.name, ...tail.map((migration) => migration.name)],
  );
  assert.deepEqual(await schema(freshAll.db), await schema(fresh.db));
  await assertSourceAuthorityTables(fresh.db);
  assert.deepEqual(await schema(fresh.db), await schema(legacy.db));
  for (const row of await fresh.db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_outfitter_migrations'",
  ))
    assert.equal(
      (await fresh.db.query(`SELECT count(*) AS n FROM "${row.name}"`))[0].n,
      0,
      `${row.name} must contain no seed data`,
    );
  assert.deepEqual(
    await migrateAppDatabase(fresh.db, migrations, baselines),
    [],
  );
});
test("existing full and partial Onto lineages preserve graph IDs, authored text, refs, revision and batch history", async (t) => {
  const { migrations, baselines } = await input();
  for (const cut of [
    ...new Set([12, baselines[0].replaces.length, migrations.length]),
  ]) {
    const { db, client } = setup();
    t.after(() => client.close());
    await migrateAppDatabase(db, migrations.slice(0, cut));
    await db.batch([
      "UPDATE graph_types SET title='Authored organization',revision=42 WHERE id='71000000-0000-4000-8000-000000000001'",
      "INSERT INTO graph_change_receipts VALUES('member:stable','doc','request','fingerprint','claim','{\"id\":\"stable-record\"}',123)",
    ]);
    await db.batch([
      `INSERT INTO graph_nodes(id,typeId,slug,title,body,source,revision,createdAt,updatedAt) VALUES('node-stable','71000000-0000-4000-8000-000000000001','authored','Authored','Preserved text','{"installationId":"source-stable","type":"Project","id":"external-stable"}',7,1,2)`,
      `INSERT INTO graph_batches(id,title,policy,state,openedBy,openedVia,createdAt,updatedAt,expiresAt) VALUES('batch-stable','Historic batch','{"kind":"member"}','committed','member-stable','oauth-client-stable',1,2,100)`,
      `INSERT INTO graph_revisions(kind,recordId,revision,batchId,proposedBy,approval,evidence,snapshot,createdAt) VALUES('graph-node','node-stable',7,'batch-stable','agent-stable','{"member":"member-stable"}','[{"provider":"github","recordId":"issue-stable"}]','{"title":"Authored"}',2)`,
      `INSERT INTO wiki_map_proposals(id,installationId,ownerId,threadId,requestKey,payloadDigest,action,status,data,receipt) VALUES('proposal-stable','installation-stable','owner-stable','thread-stable','request-stable','digest-stable','graph.apply','applied','{}','{"id":"node-stable","confirmedBy":"member-stable"}')`,
    ]);
    const sourceTablesPresent = cut === migrations.length;
    if (sourceTablesPresent)
      await db.batch([
        `INSERT INTO onto_source_definitions VALUES('organization:stable','definition-stable',1,'{}','definition-digest','installation-stable')`,
        `INSERT INTO onto_source_proofs VALUES('organization:stable','proof-stable','actor-stable','capture-stable','request-hash','issued','{}','proof-digest','{}')`,
        `INSERT INTO onto_source_fences VALUES('organization:stable','seal-stable','actor-stable','request-hash','proof-stable','{}','receipt-stable','sealed','{"status":"sealed"}',NULL)`,
      ]);
    const retainedQueries = [
      "SELECT * FROM graph_nodes ORDER BY id",
      "SELECT id,title,policy,state,openedBy,openedVia,createdAt,updatedAt,expiresAt FROM graph_batches ORDER BY id",
      "SELECT * FROM graph_revisions ORDER BY recordId",
      "SELECT * FROM wiki_map_proposals ORDER BY id",
      ...(sourceTablesPresent
        ? sourceAuthorityTables.map(
            (table) => `SELECT * FROM ${table} ORDER BY owner`,
          )
        : []),
    ];
    const retained = await Promise.all(retainedQueries.map((q) => db.query(q)));
    const previous = await db.query("SELECT * FROM graph_types ORDER BY id");
    const receipts = await db.query("SELECT * FROM graph_change_receipts");
    const applied = await migrateAppDatabase(db, migrations, baselines);
    assert.deepEqual(
      applied,
      migrations.slice(cut).map((migration) => migration.name),
    );
    await assertSourceAuthorityTables(db);
    if (!sourceTablesPresent)
      for (const table of sourceAuthorityTables)
        assert.deepEqual(await db.query(`SELECT * FROM ${table}`), []);
    assert.deepEqual(
      await db.query("SELECT * FROM graph_types ORDER BY id"),
      previous,
    );
    assert.deepEqual(
      await db.query("SELECT * FROM graph_change_receipts"),
      receipts,
    );
    assert.deepEqual(
      await Promise.all(retainedQueries.map((q) => db.query(q))),
      retained,
    );
    assert.deepEqual(
      await db.query(
        `SELECT name FROM _outfitter_migrations WHERE name='${baselines[0].name}'`,
      ),
      [],
    );
    assert.deepEqual(await migrateAppDatabase(db, migrations, baselines), []);
  }
});

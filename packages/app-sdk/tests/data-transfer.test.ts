import assert from "node:assert/strict";
import test from "node:test";
import { createClient, type InValue } from "@libsql/client";
import type { AgentDatabase } from "../src/agent-store";
import { type AppArchive, applyImport, exportArchive, planImport } from "../src/data-transfer";

const schema = [
  "CREATE TABLE _outfitter_migrations (name TEXT PRIMARY KEY NOT NULL, appliedAt INTEGER NOT NULL) STRICT",
  "INSERT INTO _outfitter_migrations VALUES ('0000_init', 1)",
  "CREATE TABLE projects (id TEXT PRIMARY KEY, installationId TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1) STRICT",
  "CREATE TABLE issues (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), parentId TEXT REFERENCES issues(id), ref TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1) STRICT",
  "CREATE TABLE receipts (key TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT",
  "CREATE TABLE types (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, revision INTEGER) STRICT",
  "CREATE TABLE guard (value INTEGER NOT NULL CHECK (value = 1)) STRICT",
];

async function database(extra: string[] = []): Promise<AgentDatabase> {
  const client = createClient({ url: "file::memory:" });
  await client.execute("PRAGMA foreign_keys = on");
  for (const sql of [...schema, ...extra]) await client.execute(sql);
  return {
    query: async (s) => (await client.execute({ sql: s.sql, args: (s.params ?? []) as InValue[] })).rows.map((row) => ({ ...row })),
    batch: (steps) => client.batch(steps.map((s) => ({ sql: s.sql, args: (s.params ?? []) as InValue[] })), "write"),
  };
}

const prodWiki = "11111111-1111-4111-8111-111111111111";
const prodPlanning = "22222222-2222-4222-8222-222222222222";
const localPlanning = "33333333-3333-4333-8333-333333333333";
const owner = { kind: "user" as const, id: "nicholas" };
const source = { installationId: prodPlanning, owner, userId: "nicholas" };
const destination = { installationId: localPlanning, owner };

async function fullArchive(db: AgentDatabase, maxBytes?: number) {
  const pages: AppArchive[] = [];
  let cursor: string | null = null;
  do {
    const page = await exportArchive(db, source, { app: "outfitter/planning", cursor, maxBytes });
    pages.push(page);
    cursor = page.cursor;
  } while (cursor);
  return pages;
}

test("an archive round-trips with stable IDs and remapped installation references", async () => {
  const prod = await database();
  await prod.batch([
    { sql: "PRAGMA defer_foreign_keys = on" },
    { sql: "INSERT INTO projects VALUES ('p1', ?, 'Outfitter', 1)", params: [prodPlanning] },
    // Child row sorts before its parent by key, and references another app's installation in JSON.
    { sql: "INSERT INTO issues VALUES ('a-child', 'p1', 'z-parent', ?, 1)", params: [JSON.stringify({ installationId: prodWiki, type: "graph-node", id: "n1" })] },
    { sql: "INSERT INTO issues VALUES ('z-parent', 'p1', NULL, '{}', 1)" },
    { sql: "INSERT INTO receipts VALUES ('r1', 'sent')" },
  ]);
  const [archive] = await fullArchive(prod);
  assert.deepEqual(Object.keys(archive.tables), ["projects", "issues", "receipts", "types"]);
  assert.deepEqual(archive.migrations, ["0000_init"]);

  const local = await database();
  const map = { [prodPlanning]: localPlanning, [prodWiki]: "44444444-4444-4444-8444-444444444444" };
  const plan = await planImport(local, destination, { archive, map });
  assert.equal(plan.tables.find((t) => t.table === "issues")?.counts.added, 2);
  await applyImport(local, destination, { archive, map, previewToken: plan.previewToken });

  const project = await local.query({ sql: "SELECT * FROM projects" });
  assert.equal(project[0].installationId, localPlanning);
  const child = await local.query({ sql: "SELECT ref FROM issues WHERE id = 'a-child'" });
  assert.equal(JSON.parse(String(child[0].ref)).installationId, "44444444-4444-4444-8444-444444444444");

  // A second pull of the same archive changes nothing.
  const again = await planImport(local, destination, { archive, map });
  assert.ok(again.tables.every((t) => t.counts.added === 0 && t.counts.updated === 0));
});

test("repeated pulls take newer source revisions and keep local-only and locally newer rows", async () => {
  const prod = await database();
  const local = await database();
  await prod.batch([
    { sql: "INSERT INTO projects VALUES ('p1', 'x', 'Old', 1)" },
    { sql: "INSERT INTO projects VALUES ('p2', 'x', 'Theirs', 1)" },
    { sql: "INSERT INTO projects VALUES ('p3', 'x', 'Same revision', 1)" },
    { sql: "INSERT INTO receipts VALUES ('r1', 'sent')" },
  ]);
  const [first] = await fullArchive(prod);
  const plan = await planImport(local, destination, { archive: first });
  await applyImport(local, destination, { archive: first, previewToken: plan.previewToken });

  await prod.batch([
    { sql: "UPDATE projects SET name = 'New', revision = 2 WHERE id = 'p1'" },
    { sql: "UPDATE projects SET name = 'Prod edit', revision = 2 WHERE id = 'p2'" },
    { sql: "UPDATE projects SET name = 'Prod same', revision = 1 WHERE id = 'p3'" },
    { sql: "UPDATE receipts SET body = 'changed' WHERE key = 'r1'" },
  ]);
  await local.batch([
    { sql: "UPDATE projects SET name = 'Mine', revision = 3 WHERE id = 'p2'" },
    { sql: "INSERT INTO projects VALUES ('local', 'x', 'Only here', 1)" },
  ]);
  const [second] = await fullArchive(prod);
  const next = await planImport(local, destination, { archive: second });
  const projects = next.tables.find((t) => t.table === "projects");
  assert.ok(projects);
  assert.deepEqual(projects.counts, { added: 0, updated: 1, unchanged: 0, newerLocally: 1, conflict: 1 });
  assert.deepEqual(projects.conflicts, [["p3"]]);
  // A keyed row without a version is a receipt: a difference is reported, never overwritten.
  assert.equal(next.tables.find((t) => t.table === "receipts")?.counts.conflict, 1);
  await applyImport(local, destination, { archive: second, previewToken: next.previewToken });

  const names = Object.fromEntries((await local.query({ sql: "SELECT id, name FROM projects" })).map((r) => [r.id, r.name]));
  assert.deepEqual(names, { p1: "New", p2: "Mine", p3: "Same revision", local: "Only here" });
  assert.equal((await local.query({ sql: "SELECT body FROM receipts" }))[0].body, "sent");
});

test("a stale preview, an older destination and pagination are handled", async () => {
  const prod = await database();
  await prod.batch(Array.from({ length: 1200 }, (_, i) => ({ sql: "INSERT INTO receipts VALUES (?, ?)", params: [`k${String(i).padStart(4, "0")}`, "x".repeat(40)] })));
  const pages = await fullArchive(prod, 20_000);
  assert.ok(pages.length > 1);
  assert.equal(pages.reduce((n, p) => n + (p.tables.receipts?.rows.length ?? 0), 0), 1200);

  const local = await database();
  const plan = await planImport(local, destination, { archive: pages[0] });
  await local.batch([{ sql: "INSERT INTO receipts VALUES ('k0000', 'local')" }]);
  await assert.rejects(applyImport(local, destination, { archive: pages[0], previewToken: plan.previewToken }), (e: Response) => e.status === 409);

  const newer = await database(["INSERT INTO _outfitter_migrations VALUES ('0001_more', 2)"]);
  const [ahead] = await fullArchive(newer);
  await assert.rejects(planImport(local, destination, { archive: ahead }), (e: Response) => e.status === 409);
  // The keyless guard table never travels.
  assert.equal(ahead.tables.guard, undefined);
});

test("unique indexes, cell types and unversioned local rows are checked before writing", async () => {
  const prod = await database();
  const local = await database();
  await prod.batch([{ sql: "INSERT INTO types VALUES ('t-prod', 'Person', 1)" }, { sql: "INSERT INTO types VALUES ('t-null', 'Place', 2)" }]);
  await local.batch([{ sql: "INSERT INTO types VALUES ('t-local', 'Person', 1)" }, { sql: "INSERT INTO types VALUES ('t-null', 'Place', NULL)" }]);
  const [archive] = await fullArchive(prod);
  // The same natural key under another ID is refused with a 409, not a failed batch.
  await assert.rejects(planImport(local, destination, { archive }), (e: Response) => e.status === 409);

  await local.batch([{ sql: "DELETE FROM types WHERE id = 't-local'" }]);
  const plan = await planImport(local, destination, { archive });
  assert.equal(plan.tables.find((t) => t.table === "types")?.counts.updated, 1);
  await applyImport(local, destination, { archive, previewToken: plan.previewToken });
  assert.equal((await local.query({ sql: "SELECT revision FROM types WHERE id = 't-null'" }))[0].revision, 2);

  const bad = structuredClone(archive);
  bad.tables.types.rows[0][2] = 1.5;
  await assert.rejects(planImport(local, destination, { archive: bad }), (e: Response) => e.status === 400);
});

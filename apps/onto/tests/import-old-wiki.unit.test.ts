import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { importOldWiki } from "../scripts/import-old-wiki";

const P = "71000000-0000-4000-8000-000000000";
const person = P + "005",
  project = P + "003",
  reportsTo = P + "023";
const custom = "00000000-0000-4000-8000-000000000901";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("a reconciled Wiki preserves records, authored seed definitions, identities and validity", () => {
  const dir = mkdtempSync(join(tmpdir(), "onto-import-"));
  try {
    const old = new DatabaseSync(join(dir, "old.sqlite"));
    old.exec(`
      CREATE TABLE graph_types (id text PRIMARY KEY, category text, name text, title text, body text, properties text, archived integer DEFAULT 0, seedVersion integer, revision integer DEFAULT 1, createdBy text, updatedBy text, createdAt integer, updatedAt integer);
      CREATE TABLE graph_nodes (id text PRIMARY KEY, typeId text, slug text, title text, summary text DEFAULT '', body text DEFAULT '', website text, properties text DEFAULT '{}', source text, externalProvider text, externalId text, privateData text DEFAULT '{}', archived integer DEFAULT 0, revision integer DEFAULT 1, createdBy text, updatedBy text, createdAt integer, updatedAt integer, validity text);
      CREATE TABLE graph_edges (id text PRIMARY KEY, typeId text, fromId text, toId text, title text DEFAULT '', body text DEFAULT '', properties text DEFAULT '{}', archived integer DEFAULT 0, revision integer DEFAULT 1, createdBy text, updatedBy text, createdAt integer, updatedAt integer, validity text);
    `);
    const type = old.prepare(
      "INSERT INTO graph_types (id, category, name, title, body, properties, createdAt, updatedAt) VALUES (?, ?, ?, ?, '', ?, 1, 1)",
    );
    type.run(person, "node", "Person", "People", "[]");
    type.run(project, "node", "Project", "Projects", "[]");
    type.run(
      reportsTo,
      "edge",
      "reports_to",
      "Authored reporting",
      JSON.stringify({
        fields: [],
        ontology: { version: 2, endpoints: { from: [person], to: [person] } },
      }),
    ); // an old copy without endpoints
    type.run(
      custom,
      "edge",
      "mentors",
      "mentors",
      JSON.stringify({
        fields: [],
        ontology: { version: 2, endpoints: { from: "any", to: "any" } },
      }),
    );
    const node = old.prepare(
      "INSERT INTO graph_nodes (id, typeId, slug, title, source, externalProvider, externalId, privateData, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)",
    );
    node.run(
      uuid(1),
      person,
      "ada",
      "Ada",
      null,
      "outfitter-principal",
      "user-1",
      "{}",
    );
    node.run(uuid(2), person, "bea", "Bea", null, null, null, "{}");
    node.run(
      uuid(3),
      project,
      "sunny",
      "Sunny",
      JSON.stringify({ installationId: "planning", type: "project", id: "p1" }),
      null,
      null,
      "{}",
    );
    const edge = old.prepare(
      "INSERT INTO graph_edges (id, typeId, fromId, toId, validity, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, 1)",
    );
    edge.run(
      uuid(11),
      reportsTo,
      uuid(1),
      uuid(2),
      JSON.stringify({ from: "2026-01-01T00:00:00Z", to: null }),
    );
    edge.run(uuid(13), custom, uuid(2), uuid(3), null);
    old.close();

    const report = importOldWiki(
      join(dir, "old.sqlite"),
      join(dir, "onto.sqlite"),
    );
    assert.equal(report.refused.length, 0);
    assert.equal(report.accounts, 1);

    const onto = new DatabaseSync(join(dir, "onto.sqlite"), { readOnly: true });
    assert.equal(
      onto.prepare("SELECT title FROM graph_types WHERE id=?").get(reportsTo)!
        .title,
      "Authored reporting",
    );
    assert.equal(statSync(join(dir, "onto.sqlite")).mode & 0o777, 0o600);
    const keys = onto
      .prepare(
        "SELECT slug, externalKey FROM graph_nodes WHERE externalKey IS NOT NULL ORDER BY slug",
      )
      .all();
    assert.deepEqual(
      keys.map((row) => ({ ...row })),
      [
        { slug: "ada", externalKey: "ai-outfitter.com/users:user-1" },
        {
          slug: "sunny",
          externalKey: "ai-outfitter.com/apps/planning/project:p1",
        },
      ],
    );
    const kept = onto
      .prepare("SELECT id, validFrom FROM graph_edges WHERE id = ?")
      .get(uuid(11));
    assert.deepEqual(
      { ...kept },
      { id: uuid(11), validFrom: "2026-01-01T00:00:00Z" },
    );
    assert.ok(
      onto
        .prepare("SELECT 1 FROM graph_types WHERE name = 'OutfitterUser'")
        .get(),
      "new seed types are added",
    );
    onto.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(run: (dir: string, old: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), "onto-import-refusal-"));
  const old = new DatabaseSync(join(dir, "old.sqlite"));
  old.exec(`
    CREATE TABLE graph_types (id TEXT, category TEXT, name TEXT, title TEXT, body TEXT, properties TEXT);
    CREATE TABLE graph_nodes (id TEXT, typeId TEXT, slug TEXT, title TEXT, privateData TEXT);
    CREATE TABLE graph_edges (id TEXT, typeId TEXT, fromId TEXT, toId TEXT);
  `);
  old
    .prepare(
      "INSERT INTO graph_types VALUES (?, 'node', 'Person', 'People', '', '[]')",
    )
    .run(person);
  old
    .prepare("INSERT INTO graph_nodes VALUES (?, ?, 'ada', 'Ada', '{}')")
    .run(uuid(1), person);
  try {
    run(dir, old);
  } finally {
    old.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a rejected edge rolls back the whole candidate and preserves the source", () =>
  fixture((dir, old) => {
    old
      .prepare(
        "INSERT INTO graph_types VALUES (?, 'edge', 'reports_to', 'Reports', '', ?)",
      )
      .run(
        reportsTo,
        JSON.stringify({
          fields: [],
          ontology: {
            version: 2,
            endpoints: { from: [project], to: [person] },
          },
        }),
      );
    old
      .prepare("INSERT INTO graph_edges VALUES (?, ?, ?, ?)")
      .run(uuid(2), reportsTo, uuid(1), uuid(1));
    const before = readFileSync(join(dir, "old.sqlite"));
    assert.throws(
      () => importOldWiki(join(dir, "old.sqlite"), join(dir, "onto.sqlite")),
      /endpoint types not allowed/,
    );
    assert.equal(existsSync(join(dir, "onto.sqlite")), false);
    assert.deepEqual(readFileSync(join(dir, "old.sqlite")), before);
  }));

test("migration refuses existing destinations, source aliases and dangling symlinks", () =>
  fixture((dir) => {
    const existing = join(dir, "onto.sqlite");
    writeFileSync(existing, "keep this database");
    assert.throws(
      () => importOldWiki(join(dir, "old.sqlite"), existing),
      /EEXIST/,
    );
    assert.equal(readFileSync(existing, "utf8"), "keep this database");
    assert.throws(
      () => importOldWiki(join(dir, "old.sqlite"), join(dir, "old.sqlite")),
      /EEXIST/,
    );
    symlinkSync(join(dir, "missing.sqlite"), join(dir, "link.sqlite"));
    assert.throws(
      () => importOldWiki(join(dir, "old.sqlite"), join(dir, "link.sqlite")),
      /EEXIST/,
    );
  }));

test("an unrecognized populated table blocks silent history loss", () =>
  fixture((dir, old) => {
    old.exec(
      "CREATE TABLE future_history (payload TEXT); INSERT INTO future_history VALUES ('must retain')",
    );
    assert.throws(
      () => importOldWiki(join(dir, "old.sqlite"), join(dir, "onto.sqlite")),
      /future_history: 1 rows have no destination mapping/,
    );
    assert.equal(existsSync(join(dir, "onto.sqlite")), false);
  }));

test("missing endpoint contracts are refused rather than widened", () =>
  fixture((dir, old) => {
    old
      .prepare(
        "INSERT INTO graph_types VALUES (?, 'edge', 'mentors', 'Mentors', '', '[]')",
      )
      .run(custom);
    assert.throws(
      () => importOldWiki(join(dir, "old.sqlite"), join(dir, "onto.sqlite")),
      /missing endpoint contract/,
    );
    assert.equal(existsSync(join(dir, "onto.sqlite")), false);
  }));

test("private data needs an explicit retention mapping", () =>
  fixture((dir, old) => {
    old.exec(`UPDATE graph_nodes SET privateData='{"secret":1}'`);
    assert.throws(
      () => importOldWiki(join(dir, "old.sqlite"), join(dir, "onto.sqlite")),
      /privateData needs a separate owner-scoped retention mapping/,
    );
  }));

test("review jobs and shared history keep every row and column", () =>
  fixture((dir, old) => {
    old.exec(`CREATE TABLE graph_explorations (slug TEXT, title TEXT, state TEXT, revision INTEGER, lastChange TEXT, createdBy TEXT, createdAt INTEGER, updatedAt INTEGER);
    INSERT INTO graph_explorations VALUES ('saved','Saved','{}',7,NULL,'owner',1,2)`);
    const report = importOldWiki(
      join(dir, "old.sqlite"),
      join(dir, "onto.sqlite"),
    );
    assert.equal(report.tables.graph_explorations, 1);
    const db = new DatabaseSync(join(dir, "onto.sqlite"), { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT revision FROM graph_explorations").get()!.revision,
        7,
      );
    } finally {
      db.close();
    }
  }));

test("unknown populated history columns are refused", () =>
  fixture((dir, old) => {
    old.exec(`CREATE TABLE graph_changes (userId TEXT, requestKey TEXT, hash TEXT, attempt TEXT, receipt TEXT, future TEXT);
    INSERT INTO graph_changes VALUES ('u','k','h','a','{}','retain')`);
    assert.throws(
      () => importOldWiki(join(dir, "old.sqlite"), join(dir, "onto.sqlite")),
      /graph_changes.future: no destination mapping/,
    );
  }));

test("malformed source JSON is not silently discarded", () =>
  fixture((dir, old) => {
    old.exec(
      "ALTER TABLE graph_nodes ADD COLUMN source TEXT; UPDATE graph_nodes SET source='invalid'",
    );
    assert.throws(
      () => importOldWiki(join(dir, "old.sqlite"), join(dir, "onto.sqlite")),
      SyntaxError,
    );
    assert.equal(existsSync(join(dir, "onto.sqlite")), false);
  }));

test("new primary-record columns cannot silently disappear", () =>
  fixture((dir, old) => {
    old.exec(
      "ALTER TABLE graph_nodes ADD COLUMN future TEXT; UPDATE graph_nodes SET future='retain'",
    );
    assert.throws(
      () => importOldWiki(join(dir, "old.sqlite"), join(dir, "onto.sqlite")),
      /graph_nodes.future: no destination mapping/,
    );
  }));

test("seed/source name collisions require explicit identity mapping", () =>
  fixture((dir, old) => {
    old
      .prepare(
        "INSERT INTO graph_types VALUES (?, 'edge', 'evidence_for', 'Evidence for', '', ?)",
      )
      .run(
        custom,
        JSON.stringify({
          fields: [],
          ontology: { version: 2, endpoints: { from: "any", to: "any" } },
        }),
      );
    assert.throws(
      () => importOldWiki(join(dir, "old.sqlite"), join(dir, "onto.sqlite")),
      /evidence_for: source id .* conflicts with seed id .* explicit identity mapping required/,
    );
    assert.equal(existsSync(join(dir, "onto.sqlite")), false);
  }));

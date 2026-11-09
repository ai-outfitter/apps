import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  promotionStatements,
  sealLineage,
  verifyTables,
} from "../scripts/wiki-migration-d1";
test("promotion inserts types and nodes before edge endpoint triggers and keeps write locks", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE graph_types(id TEXT PRIMARY KEY);
 CREATE TABLE graph_nodes(id TEXT PRIMARY KEY,typeId TEXT REFERENCES graph_types(id));
 CREATE TABLE graph_edges(id TEXT PRIMARY KEY,fromId TEXT REFERENCES graph_nodes(id));
 CREATE TRIGGER endpoint_check BEFORE INSERT ON graph_edges WHEN NOT EXISTS(SELECT 1 FROM graph_nodes WHERE id=NEW.fromId) BEGIN SELECT RAISE(ABORT,'missing node'); END;
 INSERT INTO graph_types VALUES ('old');
 CREATE TABLE _onto_cutover_stage_graph_types AS SELECT 't' AS id;
 CREATE TABLE _onto_cutover_stage_graph_nodes AS SELECT 'n' AS id,'t' AS typeId;
 CREATE TABLE _onto_cutover_stage_graph_edges AS SELECT 'e' AS id,'n' AS fromId;`);
    const snapshot = {
      tables: [
        { name: "graph_edges", columns: ["id", "fromId"], rows: [] },
        { name: "graph_nodes", columns: ["id", "typeId"], rows: [] },
        { name: "graph_types", columns: ["id"], rows: [] },
      ],
    };
    db.exec("BEGIN");
    for (const q of promotionStatements(snapshot)) db.exec(q.sql);
    db.exec("COMMIT");
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM graph_edges").get()!.n,
      1,
    );
    assert.throws(
      () => db.exec("UPDATE graph_nodes SET id='changed'"),
      /verification in progress/,
    );
  } finally {
    db.close();
  }
});
test("a failed promotion rolls back destination data and retains staged recovery", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE graph_types(id TEXT PRIMARY KEY);INSERT INTO graph_types VALUES('original');CREATE TABLE _onto_cutover_stage_graph_types(id TEXT);INSERT INTO _onto_cutover_stage_graph_types VALUES('duplicate'),('duplicate')",
    );
    db.exec("BEGIN");
    assert.throws(() => {
      for (const q of promotionStatements({
        tables: [{ name: "graph_types", columns: ["id"], rows: [] }],
      }))
        db.exec(q.sql);
    }, /UNIQUE/);
    db.exec("ROLLBACK");
    assert.equal(
      db.prepare("SELECT id FROM graph_types").get()!.id,
      "original",
    );
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM _onto_cutover_stage_graph_types")
        .get()!.n,
      2,
    );
  } finally {
    db.close();
  }
});
test("lineage receipts and source history cannot be edited, deleted or minted by an import", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE onto_wiki_migrations(id TEXT);CREATE TABLE onto_wiki_migration_sources(id TEXT)",
    );
    db.exec(
      "INSERT INTO onto_wiki_migrations VALUES('receipt');INSERT INTO onto_wiki_migration_sources VALUES('history')",
    );
    for (const q of sealLineage()) db.exec(q.sql);
    for (const sql of [
      "INSERT INTO onto_wiki_migrations VALUES('fake')",
      "DELETE FROM onto_wiki_migration_sources",
      "UPDATE onto_wiki_migrations SET id=1",
    ])
      assert.throws(() => db.exec(sql), /immutable/);
  } finally {
    db.close();
  }
});
test("verification compares complete row contents rather than counts", () => {
  const expected = {
    tables: [
      {
        name: "history",
        columns: ["id", "body"],
        rows: [{ id: "a", body: "original" }],
      },
    ],
  };
  assert.throws(
    () =>
      verifyTables(expected, {
        tables: [
          {
            name: "history",
            columns: ["id", "body"],
            rows: [{ id: "a", body: "changed" }],
          },
        ],
      }),
    /readback mismatch/,
  );
});

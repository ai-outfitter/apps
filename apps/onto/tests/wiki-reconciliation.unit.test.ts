import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileWiki } from "../scripts/reconcile-wiki";
import { importOldWiki } from "../scripts/import-old-wiki";
function fixture(run: (db: DatabaseSync, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "wiki-reconcile-"));
  const db = new DatabaseSync(join(dir, "source.sqlite"));
  db.exec(`CREATE TABLE graph_types(id TEXT,category TEXT,name TEXT,title TEXT,body TEXT,properties TEXT,revision INTEGER,createdAt INTEGER,updatedAt INTEGER);
 CREATE TABLE graph_nodes(id TEXT,typeId TEXT,slug TEXT,title TEXT,createdAt INTEGER,updatedAt INTEGER);
 CREATE TABLE graph_edges(id TEXT,typeId TEXT,fromId TEXT,toId TEXT,createdAt INTEGER,updatedAt INTEGER);`);
  try {
    run(db, dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const person = "71000000-0000-4000-8000-000000000005",
  project = "71000000-0000-4000-8000-000000000003",
  reports = "71000000-0000-4000-8000-000000000023";
function type(db: DatabaseSync, id: string, category: string, name: string) {
  db.prepare(
    "INSERT INTO graph_types VALUES (?,?,?,?,'Authored definition','[]',7,1,2)",
  ).run(id, category, name, name);
}
test("explicit reconciliation preserves authored type identity and adds revision evidence", () =>
  fixture((db, dir) => {
    type(db, person, "node", "Person");
    type(db, "custom-evidence", "edge", "evidence_for");
    const plan = reconcileWiki(db, "operator");
    assert.equal(
      plan.seedAliases["7b000000-0000-4000-8000-000000000003"],
      "custom-evidence",
    );
    importOldWiki(
      join(dir, "source.sqlite"),
      join(dir, "destination.sqlite"),
      plan,
    );
    const result = new DatabaseSync(join(dir, "destination.sqlite"), {
      readOnly: true,
    });
    try {
      const row = result
        .prepare("SELECT * FROM graph_types WHERE name='evidence_for'")
        .get()!;
      assert.equal(row.id, "custom-evidence");
      assert.equal(row.body, "Authored definition");
      assert.equal(row.revision, 8);
      const history = result
        .prepare("SELECT * FROM graph_revisions WHERE recordId=?")
        .get("custom-evidence")!;
      assert.equal(JSON.parse(String(history.prior)).revision, 7);
      assert.equal(JSON.parse(String(history.snapshot)).revision, 8);
    } finally {
      result.close();
    }
  }));
test("new restrictions cannot erase relationships accepted by the legacy contract", () =>
  fixture((db) => {
    type(db, person, "node", "Person");
    type(db, project, "node", "Project");
    type(db, reports, "edge", "reports_to");
    db.prepare(
      "INSERT INTO graph_nodes VALUES ('p',?,'person','Person',1,1)",
    ).run(person);
    db.prepare(
      "INSERT INTO graph_nodes VALUES ('j',?,'project','Project',1,1)",
    ).run(project);
    db.prepare("INSERT INTO graph_edges VALUES ('r',?,'p','j',1,1)").run(
      reports,
    );
    const patch = reconcileWiki(db, "operator").types[reports];
    assert.deepEqual(JSON.parse(patch.properties).ontology.endpoints, {
      from: "any",
      to: "any",
    });
    assert.match(patch.reason, /would reject/);
  }));
test("a source change invalidates the exact reconciliation plan", () =>
  fixture((db, dir) => {
    type(db, person, "node", "Person");
    const plan = reconcileWiki(db, "operator");
    db.exec("UPDATE graph_types SET body='concurrent edit'");
    assert.throws(
      () =>
        importOldWiki(
          join(dir, "source.sqlite"),
          join(dir, "destination.sqlite"),
          plan,
        ),
      /source changed/,
    );
  }));

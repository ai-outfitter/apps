import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { importOldWiki } from "../scripts/import-old-wiki";

const P = "71000000-0000-4000-8000-000000000";
const person = P + "005", project = P + "003", reportsTo = P + "023";
const custom = "00000000-0000-4000-8000-000000000901";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("an old Wiki copies into a fresh Onto with ids, slugs, keys and accounts, listing refused edges", () => {
  const dir = mkdtempSync(join(tmpdir(), "onto-import-"));
  try {
    const old = new DatabaseSync(join(dir, "old.sqlite"));
    old.exec(`
      CREATE TABLE graph_types (id text PRIMARY KEY, category text, name text, title text, body text, properties text, archived integer DEFAULT 0, seedVersion integer, revision integer DEFAULT 1, createdBy text, updatedBy text, createdAt integer, updatedAt integer);
      CREATE TABLE graph_nodes (id text PRIMARY KEY, typeId text, slug text, title text, summary text DEFAULT '', body text DEFAULT '', website text, properties text DEFAULT '{}', source text, externalProvider text, externalId text, privateData text DEFAULT '{}', archived integer DEFAULT 0, revision integer DEFAULT 1, createdBy text, updatedBy text, createdAt integer, updatedAt integer, validity text);
      CREATE TABLE graph_edges (id text PRIMARY KEY, typeId text, fromId text, toId text, title text DEFAULT '', body text DEFAULT '', properties text DEFAULT '{}', archived integer DEFAULT 0, revision integer DEFAULT 1, createdBy text, updatedBy text, createdAt integer, updatedAt integer, validity text);
    `);
    const type = old.prepare("INSERT INTO graph_types (id, category, name, title, body, properties, createdAt, updatedAt) VALUES (?, ?, ?, ?, '', ?, 1, 1)");
    type.run(person, "node", "Person", "People", "[]");
    type.run(project, "node", "Project", "Projects", "[]");
    type.run(reportsTo, "edge", "reports_to", "reports to", "[]"); // an old copy without endpoints
    type.run(custom, "edge", "mentors", "mentors", "[]");
    const node = old.prepare("INSERT INTO graph_nodes (id, typeId, slug, title, source, externalProvider, externalId, privateData, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)");
    node.run(uuid(1), person, "ada", "Ada", null, "outfitter-principal", "user-1", '{"secret":1}');
    node.run(uuid(2), person, "bea", "Bea", null, null, null, "{}");
    node.run(uuid(3), project, "sunny", "Sunny", JSON.stringify({ installationId: "planning", type: "project", id: "p1" }), null, null, "{}");
    const edge = old.prepare("INSERT INTO graph_edges (id, typeId, fromId, toId, validity, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, 1)");
    edge.run(uuid(11), reportsTo, uuid(1), uuid(2), JSON.stringify({ from: "2026-01-01T00:00:00Z", to: null }));
    edge.run(uuid(12), reportsTo, uuid(1), uuid(3), null); // a Project is not a Person
    edge.run(uuid(13), custom, uuid(2), uuid(3), null);
    old.close();

    const report = importOldWiki(join(dir, "old.sqlite"), join(dir, "onto.sqlite"));
    assert.deepEqual(report.openedEdgeTypes, ["mentors"]);
    assert.equal(report.refused.length, 1);
    assert.match(report.refused[0], /^reports_to\(Person:ada → Project:sunny\): .*endpoint types not allowed/);
    assert.equal(report.accounts, 1);

    const onto = new DatabaseSync(join(dir, "onto.sqlite"), { readOnly: true });
    const keys = onto.prepare("SELECT slug, externalKey FROM graph_nodes WHERE externalKey IS NOT NULL ORDER BY slug").all();
    assert.deepEqual(keys.map((row) => ({ ...row })), [
      { slug: "ada", externalKey: "ai-outfitter.com/users:user-1" },
      { slug: "sunny", externalKey: "ai-outfitter.com/apps/planning/project:p1" },
    ]);
    const kept = onto.prepare("SELECT id, validFrom FROM graph_edges WHERE id = ?").get(uuid(11));
    assert.deepEqual({ ...kept }, { id: uuid(11), validFrom: "2026-01-01T00:00:00Z" });
    assert.ok(onto.prepare("SELECT 1 FROM graph_types WHERE name = 'OutfitterUser'").get(), "new seed types are added");
    onto.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

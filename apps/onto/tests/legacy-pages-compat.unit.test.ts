import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { lockStatements, type D1 } from "../../onto/scripts/wiki-migration-d1";
import { reconcileLegacyPages } from "../scripts/reconcile-legacy-pages";

test("legacy Wiki pages remain a foreign-keyed archive while document migrations create a new page table", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-pages-compat-"));
  const source = new DatabaseSync(join(dir, "source.sqlite"));
  const destination = new DatabaseSync(join(dir, "destination.sqlite"));
  const binding = {
    owner: { kind: "user" as const, id: "owner" },
    source: { id: "old-wiki", databaseId: "source-db" },
    destination: { id: "onto", databaseId: "destination-db" },
  };
  try {
    source.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE _outfitter_migrations(name TEXT PRIMARY KEY,appliedAt INTEGER);
      CREATE TABLE graph_types(id TEXT PRIMARY KEY,name TEXT);
      CREATE TABLE graph_nodes(id TEXT PRIMARY KEY,typeId TEXT,slug TEXT,title TEXT,summary TEXT,body TEXT,revision INTEGER,archived INTEGER,createdAt INTEGER,updatedAt INTEGER,updatedBy TEXT);
      CREATE TABLE graph_revisions(kind TEXT,recordId TEXT,revision INTEGER,snapshot TEXT,prior TEXT,approval TEXT,evidence TEXT,batchId TEXT,proposedBy TEXT,createdAt INTEGER);
      CREATE TABLE wiki_pages(id TEXT PRIMARY KEY,kind TEXT,slug TEXT,title TEXT,summary TEXT,body TEXT,revision INTEGER,parentId TEXT REFERENCES wiki_pages(id),updatedAt INTEGER);
      CREATE TABLE wiki_assets(id TEXT PRIMARY KEY,pageId TEXT REFERENCES \`wiki_pages\`(\`id\`));
      CREATE TABLE wiki_links(id TEXT PRIMARY KEY,fromId TEXT REFERENCES \`wiki_pages\`(\`id\`),toId TEXT REFERENCES \`wiki_pages\`(\`id\`));
      CREATE TABLE wiki_contacts(pageId TEXT PRIMARY KEY REFERENCES \`wiki_pages\`(\`id\`),contactId TEXT);
      INSERT INTO graph_types VALUES('project-type','Project');
      INSERT INTO graph_types VALUES('document-type','Document');
      INSERT INTO graph_nodes VALUES('legacy-page','project-type','project','Legacy project','','Preserved body',1,0,1,2,NULL);
      INSERT INTO graph_nodes VALUES('document','document-type','note','Current note','','Current body',1,0,1,2,NULL);
      INSERT INTO wiki_pages VALUES('legacy-page','project','project','Legacy project','','Preserved body',1,NULL,2);
      INSERT INTO wiki_links VALUES('link','legacy-page','legacy-page');`);
    for (const statement of lockStatements(["wiki_pages", "graph_types", "graph_nodes", "graph_edges"], "migrated")) {
      if (statement.sql.includes('"graph_edges"')) source.exec("CREATE TABLE IF NOT EXISTS graph_edges(id TEXT PRIMARY KEY)");
      source.exec(statement.sql);
    }
    destination.exec("CREATE TABLE onto_wiki_migrations(ownerKind TEXT,ownerId TEXT,sourceInstallationId TEXT,destinationInstallationId TEXT); INSERT INTO onto_wiki_migrations VALUES('user','owner','old-wiki','onto')");
    const databases = new Map([[binding.source.databaseId, source], [binding.destination.databaseId, destination]]);
    const d1 = { query: async (id: string, statements: { sql: string; params?: unknown[] }[]) => {
      const db = databases.get(id);
      assert.ok(db);
      db.exec("BEGIN");
      try {
        const rows = statements.map(({ sql, params }) => db.prepare(sql).all(...(params ?? []) as never[]));
        db.exec("COMMIT");
        return rows;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } } as unknown as D1;
    const receipt = { ...binding, historyPreserved: true as const, sourceReadOnly: true as const };
    const result = await reconcileLegacyPages(d1, { ...binding, receipt, backup: join(dir, "archive.local.json"), apply: true });
    assert.equal(result.applied, true);
    assert.equal(result.counts.pages, 1);
    assert.equal(result.counts.links, 1);
    assert.equal(source.prepare("SELECT body FROM wiki_legacy_pages WHERE id='legacy-page'").get()?.body, "Preserved body");
    assert.deepEqual([...new Set(source.prepare("PRAGMA foreign_key_list(wiki_links)").all().map(row => row.table))], ["wiki_legacy_pages"]);
    assert.deepEqual(source.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => source.exec("UPDATE wiki_legacy_pages SET body='changed'"), /migrated/);
    source.exec(readFileSync(new URL("../migrations/0012_documents.sql", import.meta.url), "utf8"));
    source.exec(readFileSync(new URL("../migrations/0013_imported_revision.sql", import.meta.url), "utf8"));
    assert.equal(source.prepare("SELECT count(*) AS n FROM wiki_pages").get()?.n, 1);
    assert.equal(source.prepare("SELECT count(*) AS n FROM wiki_legacy_pages").get()?.n, 1);
    assert.equal(source.prepare("SELECT count(*) AS n FROM wiki_links").get()?.n, 1);
    assert.deepEqual(source.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(source.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    await assert.rejects(reconcileLegacyPages(d1, { ...binding, receipt, backup: join(dir, "again.local.json"), apply: true }));
  } finally {
    source.close(); destination.close(); rmSync(dir, { recursive: true, force: true });
  }
});

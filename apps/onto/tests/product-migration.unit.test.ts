import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalProductRoute } from "../src/lib/product-route";
import { standardData } from "../src/lib/standard-data";

const software = "71000000-0000-4000-8000-000000000008";
const product = "71000000-0000-4000-8000-000000000015";
const lens = "71000000-0000-4000-8000-000000000066";
const migration = (name: string) => readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8");

test("Product consolidation preserves identities, authored data and edges, including archived nodes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of ["0000_graph", "0001_knowledge_graphs", "0002_graph_changes"]) db.exec(migration(name));
    db.prepare("UPDATE graph_types SET body = ? WHERE id = ?").run("Authored product documentation", product);
    const insert = db.prepare("INSERT INTO graph_nodes (id,typeId,slug,title,body,properties,archived,revision,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,4,1,2)");
    insert.run("authored", software, "authored", "Outfitter Organizations", "Keep my documentation", '{"custom":"keep"}', 0);
    insert.run("archived", software, "archived", "Old product", "Keep archived", "{}", 1);
    for (const [id, root] of [["name-lens", "\tSoftwareProduct\n"], ["id-lens", `\r${software}\u00a0`]]) {
      insert.run(id, lens, id, id, "Authored lens", JSON.stringify({root_type: root, pattern: '{"relationships":["uses"],"max_depth":2}', custom: "keep"}), 0);
    }
    db.exec(`INSERT INTO graph_edges (id,typeId,fromId,toId,createdAt,updatedAt) VALUES ('authored-edge','71000000-0000-4000-8000-000000000024','authored','archived',1,2)`);
    const before = db.prepare("SELECT * FROM graph_nodes WHERE typeId = ? ORDER BY id").all(software);
    const edges = db.prepare("SELECT * FROM graph_edges ORDER BY id").all();
    const type = db.prepare("SELECT * FROM graph_types WHERE id = ?").get(software)!;
    db.exec(migration("0003_consolidate_products"));
    assert.equal(db.prepare("SELECT count(*) AS n FROM graph_nodes WHERE typeId = ?").get(software)!.n, 0);
    for (const old of before) {
      const current = db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(old.id as string)!;
      assert.equal(current.typeId, product);
      assert.equal(current.revision, Number(old.revision) + 1);
      for (const field of Object.keys(old).filter(key => !["typeId", "revision", "updatedBy", "updatedAt"].includes(key))) assert.deepEqual(current[field], old[field], field);
    }
    assert.deepEqual(db.prepare("SELECT * FROM graph_edges ORDER BY id").all(), edges);
    assert.equal(db.prepare("SELECT body FROM graph_types WHERE id = ?").get(product)!.body, "Authored product documentation");
    const archivedType = db.prepare("SELECT * FROM graph_types WHERE id = ?").get(software)!;
    assert.equal(archivedType.archived, 1);
    assert.equal(archivedType.body, type.body);
    for (const [id, root] of [["name-lens", "Product"], ["id-lens", product]]) {
      const row = db.prepare("SELECT properties FROM graph_nodes WHERE id = ?").get(id)!;
      assert.deepEqual(JSON.parse(String(row.properties)), {root_type: root, pattern: '{"relationships":["uses"],"max_depth":2}', custom: "keep"});
    }
    const after = db.prepare("SELECT * FROM graph_nodes ORDER BY id").all();
    const typesAfter = db.prepare("SELECT * FROM graph_types ORDER BY id").all();
    db.exec(migration("0003_consolidate_products"));
    assert.deepEqual(db.prepare("SELECT * FROM graph_nodes ORDER BY id").all(), after);
    assert.deepEqual(db.prepare("SELECT * FROM graph_types ORDER BY id").all(), typesAfter);
  } finally { db.close(); }
});

test("new installations seed Product without reviving SoftwareProduct", () => {
  assert.ok(standardData.types.some(type => type.id === product));
  assert.ok(!standardData.types.some(type => type.id === software || type.name === "SoftwareProduct"));
  assert.ok(!standardData.nodes.some(node => node.typeId === software));
});

test("legacy product routes retain owner mount, identity and nested view", () => {
  for (const mount of ["/o/outfitter/wiki-map", "/apps/installation-id", "/o/software-products/wiki-map"]) {
    for (const suffix of ["", "/node-id", "/node-id/connections", "/node-id/knowledge-graphs/lens-id"]) {
      assert.equal(canonicalProductRoute(new URL(`https://example.test${mount}/software-products${suffix}?tab=details`), "software-products"), `${mount}/products${suffix}?tab=details`);
    }
  }
  assert.equal(canonicalProductRoute(new URL("https://example.test/products/a"), "products"), undefined);
});

test("Product documentation migration refreshes package wording and preserves authored definitions", () => {
  for (const authored of [false, true]) {
    const db = new DatabaseSync(":memory:");
    try {
      for (const name of ["0000_graph", "0001_knowledge_graphs", "0002_graph_changes", "0003_consolidate_products"]) db.exec(migration(name));
      const types = standardData.types.filter((type) => ["Technology", "Product", "packages_product"].includes(type.name));
      if (authored) db.prepare("UPDATE graph_types SET body = 'Authored documentation', updatedBy = 'member' WHERE id = ?").run(product);
      db.exec(migration("0004_product_documentation"));
      for (const type of types) {
        const stored = db.prepare("SELECT body FROM graph_types WHERE id = ?").get(type.id)!;
        assert.equal(stored.body, authored && type.id === product ? "Authored documentation" : type.body);
      }
      const before = db.prepare("SELECT * FROM graph_types ORDER BY id").all();
      db.exec(migration("0004_product_documentation"));
      assert.deepEqual(db.prepare("SELECT * FROM graph_types ORDER BY id").all(), before, "rerunning preserves revisions and timestamps");
    } finally {
      db.close();
    }
  }
});

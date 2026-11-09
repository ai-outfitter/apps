import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";
import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import definitions from "../seeds/artifacts-v1.json";
import example from "../seeds/release-example-v1.json";
import { readType, storeType } from "../src/lib/type-metadata";
import { definitions as ontologyDefinitions, people, marriage } from "./fixtures/relators";
import { wikiGraph } from "@ai-outfitter/onto/contracts";
import { typeInput } from "../src/lib/graph";
import { standardData } from "../src/lib/standard-data";
import { setupStandardData } from "../src/server/standard-data";
import { demoGraph } from "../fixtures/graph";
import {
  exploreKnowledgeGraph,
  loadKnowledgeGraph,
} from "../src/lib/knowledge-graphs";
import { structuredBodyMarkdown } from "../src/lib/structured-body";

const owner = {
  userId: "owner",
  installationId: "wiki",
  owner: { kind: "user" as const, id: "owner" },
  role: "owner",
  canEdit: true,
};

test("seed initialization validates installed contracts and rolls back a stale snapshot", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    install(db);
    await setupStandardData(adapter(db), owner);
    const edge = standardData.edges[0];
    const from = standardData.nodes.find((node) => node.id === edge.fromId);
    const to = standardData.nodes.find((node) => node.id === edge.toId);
    assert.ok(from && to);
    const wrong = standardData.types.find((type) => type.category === "node" && type.id !== from.typeId);
    const definition = standardData.types.find((type) => type.id === edge.typeId);
    assert.ok(wrong && definition);
    db.prepare("DELETE FROM graph_edges WHERE id=?").run(edge.id);
    const constrained = storeType({ ...definition, ontology: { version: 1, endpoints: { from: [wrong.id], to: [to.typeId] } } });
    db.prepare("UPDATE graph_types SET properties=?, updatedBy='owner', revision=revision+1 WHERE id=?").run(JSON.stringify(constrained.properties), definition.id);
    await assert.rejects(setupStandardData(adapter(db), owner), (error: unknown) => error instanceof Response && error.status === 400);
    assert.equal(db.prepare("SELECT id FROM graph_edges WHERE id=?").get(edge.id), undefined);
    db.prepare("UPDATE graph_types SET properties=?, revision=revision+1 WHERE id=?").run(JSON.stringify(storeType(definition).properties), definition.id);
    const normal = adapter(db);
    const raced: AgentDatabase = { ...normal, batch: async (statements) => {
      db.prepare("UPDATE graph_nodes SET revision=revision+1 WHERE id=?").run(from.id);
      return normal.batch(statements);
    } };
    await assert.rejects(setupStandardData(raced, owner), (error: unknown) => error instanceof Response && error.status === 409);
    assert.equal(db.prepare("SELECT id FROM graph_edges WHERE id=?").get(edge.id), undefined);
    assert.equal(db.prepare("SELECT count(*) AS n FROM graph_changes").get()?.n, 0);
  } finally { db.close(); }
});
function install(db: DatabaseSync) {
  // Structure only: these tests prove JSON can populate the entire empty graph.
  db.exec(readFileSync(new URL("../migrations/0000_onto.sql", import.meta.url), "utf8"));
}
function adapter(db: DatabaseSync): AgentDatabase {
  return {
    query: async ({ sql, params }) =>
      db.prepare(sql).all(...((params ?? []) as SQLInputValue[])),
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        for (const { sql, params } of statements)
          db.prepare(sql).run(...((params ?? []) as SQLInputValue[]));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
function snapshot(db: DatabaseSync) {
  return ["graph_types", "graph_nodes", "graph_edges"].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
  );
}
test("public structured definitions round-trip through metadata and readable bodies", () => {
  for (const definition of definitions.types) {
    const stored = storeType(typeInput.parse(definition));
    const restored = readType(stored);
    assert.deepEqual(restored.properties, definition.properties);
    if ("jsonSchema" in definition)
      assert.deepEqual(
        "jsonSchema" in restored ? restored.jsonSchema : undefined,
        definition.jsonSchema,
      );
    assert.equal(Object.hasOwn(stored, "jsonSchema"), false);
  }
  for (const node of example.nodes) {
    const type =
      demoGraph.types.find((t) => t.id === node.typeId) ??
      assert.fail("Missing example type");
    if (!type.jsonSchema) continue;
    z.fromJSONSchema(type.jsonSchema).parse(JSON.parse(node.body));
    assert.ok(
      structuredBodyMarkdown(node.body, type.jsonSchema)?.includes("##"),
      node.title,
    );
  }
});
test("JSON alone populates an empty graph and repeated uploads change nothing", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    install(db);
    await setupStandardData(adapter(db), owner);
    const before = snapshot(db);
    for (let upload = 0; upload < 3; upload++)
      await setupStandardData(adapter(db), owner);
    assert.deepEqual(snapshot(db), before);
    assert.equal(before[0].length, standardData.types.length);
    assert.equal(before[1].length, standardData.nodes.length);
    assert.equal(before[2].length, standardData.edges.length);
    for (const type of definitions.types) {
      const row =
        db
          .prepare("SELECT properties FROM graph_types WHERE id=?")
          .get(type.id) ?? assert.fail("Missing type");
      if ("jsonSchema" in type)
        assert.deepEqual(
          JSON.parse(String(row.properties)).jsonSchema,
          type.jsonSchema,
        );
    }
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM graph_nodes WHERE id LIKE '77000000%'",
        )
        .get()?.n,
      1,
      "only the reusable lens, not fictional history, is standard data",
    );
  } finally {
    db.close();
  }
});
test("untouched seed knowledge graphs upgrade to the current seed; edited ones stay", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    install(db);
    await setupStandardData(adapter(db), owner);
    const [overview, decision] = ["organization-overview", "decision-context"].map((slug) =>
      standardData.nodes.find((node) => node.slug === slug) ?? assert.fail(slug));
    const legacy = JSON.stringify({ ...JSON.parse(overview.body), query: undefined, hash: undefined, variables: undefined });
    db.prepare("UPDATE graph_nodes SET body=?, revision=3 WHERE id=?").run(legacy, overview.id);
    db.prepare("UPDATE graph_nodes SET body='Owner notes', revision=4, updatedBy='owner' WHERE id=?").run(decision.id);
    await setupStandardData(adapter(db), owner);
    const row = (id: string) => db.prepare("SELECT body, revision, updatedBy FROM graph_nodes WHERE id=?").get(id) ?? assert.fail(id);
    assert.deepEqual({ ...row(overview.id) }, { body: overview.body, revision: 4, updatedBy: "seed:wiki-standard-data" });
    assert.match(String(JSON.parse(String(row(overview.id).body)).query), /^query OrganizationOverview\(\$roots: \[String!\]!\)/);
    assert.deepEqual({ ...row(decision.id) }, { body: "Owner notes", revision: 4, updatedBy: "owner" });
    // A document recompiled over this Wiki's types (another app added a type) is not reset to the seed's.
    const recompiled = JSON.stringify({ ...JSON.parse(overview.body), query: "query OrganizationOverview($roots: [String!]!) { organizations(slugs: $roots) { nodes { id } } }", hash: "0".repeat(64) });
    db.prepare("UPDATE graph_nodes SET body=? WHERE id=?").run(recompiled, overview.id);
    await setupStandardData(adapter(db), owner);
    assert.deepEqual({ ...row(overview.id) }, { body: recompiled, revision: 4, updatedBy: "seed:wiki-standard-data" });
    const settled = snapshot(db);
    await setupStandardData(adapter(db), owner);
    assert.deepEqual(snapshot(db), settled, "an upgraded seed is not rewritten again");
  } finally {
    db.close();
  }
});
test("uploads preserve edits, archives and provenance while adding new or missing IDs", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    install(db);
    await setupStandardData(adapter(db), owner);
    const type =
      standardData.types.find((t) => t.name === "UserStory") ??
      assert.fail("Missing story");
    db.prepare(
      "UPDATE graph_types SET body='Owner notes', archived=1, revision=7, updatedBy='owner' WHERE id=?",
    ).run(type.id);
    const before = db
      .prepare("SELECT * FROM graph_types WHERE id=?")
      .get(type.id);
    const added = {
      ...type,
      id: "79000000-0000-4000-8000-000000000001",
      name: "FutureSeedType",
    };
    const next = { ...standardData, types: [...standardData.types, added] };
    await setupStandardData(adapter(db), owner, next);
    assert.deepEqual(
      db.prepare("SELECT * FROM graph_types WHERE id=?").get(type.id),
      before,
    );
    assert.equal(
      db.prepare("SELECT id FROM graph_types WHERE id=?").get(added.id)?.id,
      added.id,
    );
    db.prepare("DELETE FROM graph_types WHERE id=?").run(added.id);
    await setupStandardData(adapter(db), owner, next);
    assert.equal(
      db.prepare("SELECT id FROM graph_types WHERE id=?").get(added.id)?.id,
      added.id,
    );
    const restored = snapshot(db);
    await setupStandardData(adapter(db), owner, next);
    assert.deepEqual(snapshot(db), restored);
  } finally {
    db.close();
  }
});
test("setup is editor-only and conflicting uploads commit no partial graph", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    install(db);
    await assert.rejects(
      setupStandardData(adapter(db), { ...owner, canEdit: false }),
      (error: unknown) => error instanceof Response && error.status === 403,
    );
    db.exec(
      "INSERT INTO graph_types(id,category,name,title,body,properties,archived,revision,createdAt,updatedAt) VALUES('different-id','node','ProductRevision','Custom','Owner data','[]',0,1,1,1)",
    );
    // The authored type keeps its name and the seed's copy is skipped, so the
    // seed link types that point at the seeded ProductRevision fail validation.
    const before = snapshot(db);
    await assert.rejects(setupStandardData(adapter(db), owner), (error: unknown) => error instanceof Response && error.status === 400);
    assert.deepEqual(snapshot(db), before);
  } finally {
    db.close();
  }
});

test("release lens isolates candidates and records exact criterion and subject revisions", () => {
  const find = (slug: string) =>
    demoGraph.nodes.find((n) => n.slug === `synthetic-release-${slug}`) ??
    assert.fail(`Missing example node: ${slug}`);
  const lens = loadKnowledgeGraph(demoGraph, find("graph"));
  const first = exploreKnowledgeGraph(demoGraph, find("candidate"), lens);
  for (const key of [
    "demo",
    "evaluation",
    "assessment",
    "approval",
    "release",
    "verification",
    "spec",
    "criterion",
  ])
    assert.ok(
      first.nodes.some((n) => n.id === find(key).id),
      key,
    );
  const second = exploreKnowledgeGraph(demoGraph, find("next-candidate"), lens);
  for (const key of [
    "evaluation",
    "assessment",
    "approval",
    "release",
    "verification",
  ])
    assert.ok(!second.nodes.some((n) => n.id === find(key).id), key);
  const evaluation = JSON.parse(find("evaluation").body);
  assert.deepEqual(evaluation.subject, {
    id: find("candidate").id,
    revision: 1,
  });
  assert.deepEqual(evaluation.criterion, {
    id: find("criterion").id,
    revision: 1,
  });
  // Editing a criterion does not rewrite historical evidence or grant the new
  // candidate that old result. The Wiki is a record store, not a release gate.
  const changedCriterion = { ...find("criterion"), revision: 2 };
  assert.notEqual(evaluation.criterion.revision, changedCriterion.revision);
  assert.notEqual(evaluation.subject.id, find("next-candidate").id);
});

test("setup preserves authored nodes occupying sample slugs and omits their sample relationships", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    install(db);
    const sample =
      standardData.nodes.find((node) => node.slug === "outfitter") ??
      assert.fail("Missing sample");
    for (const type of standardData.types) {
      const row = storeType(type);
      db.prepare(
        "INSERT INTO graph_types(id,category,name,title,body,properties,archived,revision,createdAt,updatedAt) VALUES(?,?,?,?,?,?,0,1,1,1)",
      ).run(
        row.id ?? type.id,
        row.category,
        row.name,
        row.title,
        row.body,
        JSON.stringify(row.properties),
      );
    }
    db.prepare(
      "INSERT INTO graph_nodes(id,typeId,title,slug,summary,body,properties,archived,revision,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,0,7,1,1)",
    ).run(
      "authored",
      sample.typeId,
      "Authored organization",
      sample.slug ?? assert.fail("Sample needs a slug"),
      "",
      "Private authored notes",
      "{}",
    );
    const before = db
      .prepare("SELECT * FROM graph_nodes WHERE id='authored'")
      .get();
    await setupStandardData(adapter(db), owner);
    assert.deepEqual(
      db.prepare("SELECT * FROM graph_nodes WHERE id='authored'").get(),
      before,
    );
    assert.equal(
      db.prepare("SELECT id FROM graph_nodes WHERE id=?").get(sample.id),
      undefined,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_edges WHERE fromId=? OR toId=?",
        )
        .get(sample.id, sample.id)?.n,
      0,
    );
    const after = snapshot(db);
    await setupStandardData(adapter(db), owner);
    assert.deepEqual(snapshot(db), after);
  } finally {
    db.close();
  }
});


test("native seed setup creates complete relators atomically and preserves authored records", async () => {
  const db = new DatabaseSync(":memory:"); install(db);
  const operations = [...ontologyDefinitions(), ...people(), ...marriage()];
  const refs = new Map(operations.map(op => [op.ref, (op.attributes as { id: string }).id]));
  const resolved = operations.map(op => {
    const attributes = { ...op.attributes } as Record<string, unknown>;
    for (const key of ["typeId", "fromId", "toId"]) {
      const value = attributes[key];
      if (typeof value === "string" && value.startsWith("$")) attributes[key] = refs.get(value);
    }
    return { ...op, attributes };
  });
  const data = wikiGraph.parse({
    types: [...standardData.types, ...resolved.filter(op => op.type === "graph-type").map(op => op.attributes)],
    nodes: resolved.filter(op => op.type === "graph-node").map(op => op.attributes), edges: resolved.filter(op => op.type === "graph-edge").map(op => op.attributes),
  });
  try {
    await setupStandardData(adapter(db), owner, data);
    const union = data.nodes.find(n => n.typeId === (resolved[0].attributes.id));
    assert.ok(union);
    db.prepare("UPDATE graph_nodes SET body='Authored note', revision=2 WHERE id=?").run(union.id);
    await setupStandardData(adapter(db), owner, data);
    assert.equal((db.prepare("SELECT body FROM graph_nodes WHERE id=?").get(union.id) as { body: string }).body, "Authored note");
    assert.equal((db.prepare("SELECT count(*) AS count FROM graph_changes").get() as { count: number }).count, 0);
  } finally { db.close(); }
});

test("a Wiki that created a seed type's name itself keeps its own type", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    install(db);
    // A Wiki set up before evidence_for was seeded, whose evidence bundles created it.
    const evidenceSeeds = (record: { id: string }) => record.id.startsWith("7b000000-");
    const data = wikiGraph.parse({ types: standardData.types.filter((type) => !evidenceSeeds(type)), nodes: standardData.nodes.filter((node) => !evidenceSeeds(node)), edges: standardData.edges.filter((edge) => !evidenceSeeds(edge)) });
    await setupStandardData(adapter(db), owner, data);
    const own = "10960c6c-0467-44f0-9172-d413ee3abee6";
    db.prepare("INSERT INTO graph_types (id, category, name, title, body, properties, archived, revision, createdBy, updatedBy, createdAt, updatedAt) VALUES (?, 'edge', 'evidence_for', 'evidence for', 'Created by an evidence bundle.', '[]', 0, 1, 'owner', 'owner', 1, 1)").run(own);
    await setupStandardData(adapter(db), owner);
    assert.deepEqual(db.prepare("SELECT id FROM graph_types WHERE name='evidence_for'").all().map((row) => row.id), [own]);
    assert.deepEqual(db.prepare("SELECT count(*) AS n FROM graph_types WHERE id LIKE '7b000000-%'").get()?.n, standardData.types.filter(evidenceSeeds).length - 1);
    assert.deepEqual(db.prepare("SELECT slug FROM graph_nodes WHERE id LIKE '7b000000-%' ORDER BY slug").all().map((row) => row.slug), ["product-chain"]);
    const before = snapshot(db);
    await setupStandardData(adapter(db), owner);
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});

test("legacy seed documentation updates once while authored and archived types remain intact", async () => {
  const upgrades = (await import("../seeds/type-documentation-upgrades-v1.json", { with: { type: "json" } })).default;
  for (const change of [{}, { revision: 2 }, { updatedBy: "owner" }, { archived: 1 }]) {
    const db = new DatabaseSync(":memory:");
    try {
      install(db);
      await setupStandardData(adapter(db), owner);
      for (const upgrade of upgrades) {
        db.prepare("UPDATE graph_types SET body=?, revision=?, createdBy='seed:types-v1', updatedBy=?, archived=? WHERE id=?")
          .run(upgrade.previousBody, change.revision ?? 1, change.updatedBy ?? "seed:types-v1", change.archived ?? 0, upgrade.id);
      }
      const before = snapshot(db);
      await setupStandardData(adapter(db), owner);
      if ("updatedBy" in change || "archived" in change) assert.deepEqual(snapshot(db), before);
      else for (const upgrade of upgrades) {
        const row = db.prepare("SELECT body,revision,createdBy,updatedBy FROM graph_types WHERE id=?").get(upgrade.id);
        assert.equal(row?.body, standardData.types.find(type => type.id === upgrade.id)?.body);
        assert.equal(row?.revision, (change.revision ?? 1) + 1);
        assert.equal(row?.createdBy, "seed:types-v1");
        assert.equal(row?.updatedBy, "seed:wiki-standard-data");
      }
      const after = snapshot(db);
      await setupStandardData(adapter(db), owner);
      assert.deepEqual(snapshot(db), after);
    } finally { db.close(); }
  }
});

test("new seed records validate with their simultaneous seed contract upgrade", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    install(db);
    await setupStandardData(adapter(db), owner);
    const id = "16ae7b75-1acb-4db9-9872-860ef61045c9";
    const type = structuredClone(standardData.types.find((item) => item.id === id)!);
    delete (type.jsonSchema as { properties: Record<string, unknown> }).properties.sectionMappings;
    db.prepare("UPDATE graph_types SET properties=? WHERE id=?").run(JSON.stringify(storeType(type).properties), id);
    db.prepare("DELETE FROM graph_edges WHERE id=?").run("7a000000-0000-4000-8000-000000000020");
    db.prepare("DELETE FROM graph_nodes WHERE id=?").run("7a000000-0000-4000-8000-000000000011");
    await setupStandardData(adapter(db), owner);
    assert.ok(db.prepare("SELECT id FROM graph_nodes WHERE id=?").get("7a000000-0000-4000-8000-000000000011"));
    assert.ok(db.prepare("SELECT id FROM graph_edges WHERE id=?").get("7a000000-0000-4000-8000-000000000020"));
    const row = db.prepare("SELECT properties FROM graph_types WHERE id=?").get(id)!;
    assert.match(String(row.properties), /sectionMappings/);
  } finally { db.close(); }
});

test("setup defers incompatible standard nodes without changing authored contracts", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    install(db);
    await setupStandardData(adapter(db), owner);
    const id = "16ae7b75-1acb-4db9-9872-860ef61045c9";
    const type = structuredClone(standardData.types.find((item) => item.id === id)!);
    delete (type.jsonSchema as { properties: Record<string, unknown> }).properties.sectionMappings;
    const properties = JSON.stringify(storeType(type).properties);
    db.prepare("UPDATE graph_types SET properties=?,updatedBy='owner' WHERE id=?").run(properties, id);
    const node = "7a000000-0000-4000-8000-000000000011";
    const edge = "7a000000-0000-4000-8000-000000000020";
    db.prepare("DELETE FROM graph_edges WHERE id=?").run(edge);
    db.prepare("DELETE FROM graph_nodes WHERE id=?").run(node);
    const other = standardData.nodes.find((item) => item.id !== node && !standardData.edges.some((e) => e.fromId === item.id || e.toId === item.id))!;
    db.prepare("DELETE FROM graph_nodes WHERE id=?").run(other.id);
    await setupStandardData(adapter(db), owner);
    assert.equal(db.prepare("SELECT id FROM graph_nodes WHERE id=?").get(node), undefined);
    assert.equal(db.prepare("SELECT id FROM graph_edges WHERE id=?").get(edge), undefined);
    assert.ok(db.prepare("SELECT id FROM graph_nodes WHERE id=?").get(other.id));
    assert.equal(db.prepare("SELECT properties FROM graph_types WHERE id=?").get(id)?.properties, properties);
    db.prepare("UPDATE graph_types SET properties=? WHERE id=?").run(JSON.stringify(storeType(standardData.types.find((item) => item.id === id)!).properties), id);
    await setupStandardData(adapter(db), owner);
    assert.ok(db.prepare("SELECT id FROM graph_nodes WHERE id=?").get(node));
    assert.ok(db.prepare("SELECT id FROM graph_edges WHERE id=?").get(edge));
  } finally { db.close(); }
});

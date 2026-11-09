import releaseExample from "../seeds/release-example-v1.json";
import assert from "node:assert/strict";
import { test } from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { defaultEntities } from "../src/lib/default-entities";
import { defaultTypes } from "../src/lib/default-types";
import { core } from "../src/lib/graph";
import {
  PERSONAL_SEED_FILE,
  SEED_FORMAT,
  inspectPersonalData,
  seedPersonalInstallation,
} from "../scripts/local-seed";

// Synthetic records only. The real personal graph stays in the ignored private data directory.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hobby = uuid(90);
const type = (id: string, category: "node" | "edge", name: string) => ({
  id, category, name, title: name, body: `${name} records.`, properties: [], archived: false,
  ...(category === "edge" ? { ontology: { version: 2 as const, endpoints: { from: "any" as const, to: "any" as const } } } : {}),
});
const packageType = (id: string) => defaultTypes.find((t) => t.id === id) ?? assert.fail(`no package type ${id}`);
const node = (id: string, typeId: string, title: string, extra = {}) => ({
  id, typeId, title, slug: title.toLowerCase().replaceAll(" ", "-"), summary: "", body: "",
  website: null, properties: {}, archived: false, ...extra,
});
const partOf = "71000000-0000-4000-8000-000000000032";
const edge = (id: number, from: string, to: string, extra = {}) => ({
  id: uuid(id), typeId: core.uses, fromId: from, toId: to, title: "", body: "", properties: {}, archived: false, ...extra,
});
// A package entity the viewer edited: the seed's version replaces the package's.
const edited = defaultEntities.find((n) => n.typeId !== core.project) ?? assert.fail("no package entity");
const OLD_PATTERN = '{"root":"Organization","nodes":[],"edges":[]}';
const seed = {
  format: SEED_FORMAT,
  types: [
    // A saved definition replaces the package's, every field included.
    { ...packageType(core.organization), body: "An older export's wording." },
    {
      ...packageType(core.uses),
      properties: [
        ...packageType(core.uses).properties,
        { name: "since", type: "string" as const, description: "When it started.", required: false },
      ],
    },
    packageType(core.technology),
    packageType(core.project),
    packageType(core.knowledgeGraph),
    packageType(partOf),
    type(hobby, "node", "Hobby"),
  ],
  nodes: [
    node(uuid(1), core.organization, "Personal Org"),
    node(uuid(2), core.technology, "Personal Archive", { archived: true }),
    node(uuid(3), hobby, "Personal Hobby"),
    { ...edited, title: "Edited package entity", summary: "", body: "", website: null, properties: {}, archived: false },
    // A historical lens format this Wiki cannot run: stored as saved, with a notice.
    node(uuid(5), core.knowledgeGraph, "Old lens", { properties: { root_type: "Organization", pattern: OLD_PATTERN } }),
  ],
  projects: [
    // Exported from another environment: its reference is replaced.
    node(uuid(10), core.project, "Personal Plan", { source: { installationId: "elsewhere", type: "project", id: uuid(77) } }),
    node(uuid(11), core.project, "Second Plan"),
  ],
  edges: [
    edge(20, uuid(1), uuid(2), { properties: { since: "2020" } }),
    edge(21, uuid(3), uuid(10), { typeId: partOf }),
    edge(22, uuid(10), uuid(11), { typeId: partOf, archived: true }),
    edge(23, edited.id, uuid(1), { typeId: partOf }),
  ],
};
const installations = { "wiki-map": "local-personal-wiki-map", planning: "local-personal-planning" };
const context = { dataDirectory: "/nonexistent", seed, installations };
const viewer = { userId: "local-viewer", organizationId: "", role: "owner", owner: { kind: "user", id: "local-viewer" } };
type Stored = { id: string; title: string; archived: boolean; source: unknown; typeId: string };
const snapshot = async (wiki: Awaited<ReturnType<typeof appWorker>>) => {
  const response = await wiki.call("/api/apps/wiki-map/graph/snapshot", viewer);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as { types: { id: string; body: string; archived: boolean }[]; nodes: Stored[]; edges: Stored[] };
};

test("the personal graph is restored whole, with Project pages referencing personal Planning", async () => {
  const inspected = await inspectPersonalData(context);
  assert.equal(inspected.source, PERSONAL_SEED_FILE);
  assert.equal(inspected.counts["project pages"], 2);
  const notices = inspected.notices.join("\n");
  assert.match(notices, /1 exported project references now point to local-personal-planning/);
  assert.match(notices, /2 saved type definitions replace the package's/);
  assert.match(notices, new RegExp(`1 knowledge graphs use a pattern this Wiki cannot run \\(${uuid(5)}\\); they are stored unchanged`));
  assert.match(notices, /1 package entities and relationships are also in the seed/);

  const wiki = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"), installations["wiki-map"]);
  try {
    const initialized = await wiki.call("/api/internal/app-initialize", { userId: "installer", organizationId: "org", role: "owner" }, { method: "POST", body: {} });
    assert.equal(initialized.status, 200);
    const before = await snapshot(wiki);
    const report = await seedPersonalInstallation({ ...context, database: wiki.database, installationId: installations["wiki-map"] });
    // A fresh baseline has no retired legacy type; initialization follows current defaults.
    assert.ok(!before.types.some((t) => t.id === "71000000-0000-4000-8000-000000000008"));
    assert.deepEqual(report.counts, inspected.counts);
    assert.deepEqual(report.counts, {
      types: before.types.length + 1,
      nodes: before.nodes.length + 6 + releaseExample.nodes.filter((n) => !before.nodes.some((stored) => stored.id === n.id)).length,
      edges: before.edges.length + 4 + releaseExample.edges.length,
      "project pages": 2,
    });
    const graph = await snapshot(wiki);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const example of releaseExample.nodes) assert.ok(byId.has(example.id), example.title);
    const restarted = await seedPersonalInstallation({ ...context, database: wiki.database, installationId: installations["wiki-map"] });
    assert.deepEqual(restarted.counts, report.counts);
    for (const id of [uuid(10), uuid(11)])
      assert.deepEqual(byId.get(id)?.source, { installationId: "local-personal-planning", type: "project", id });
    assert.equal(byId.get(uuid(1))?.source, null);
    assert.equal(byId.get(uuid(2))?.archived, true);
    assert.equal(byId.get(edited.id)?.title, "Edited package entity");
    assert.equal((byId.get(uuid(5)) as unknown as { properties: { pattern: string } }).properties.pattern, OLD_PATTERN);
    // Relationships to Project pages keep their endpoints; archived ones stay archived.
    const edges = new Map(graph.edges.map((e) => [e.id, e]));
    for (const n of [20, 21, 22, 23]) assert.ok(edges.has(uuid(n)), `relationship ${n}`);
    assert.equal(edges.get(uuid(22))?.archived, true);
    assert.ok(graph.types.some((t) => t.id === hobby));
    assert.equal(graph.types.find((t) => t.id === core.organization)?.body, "An older export's wording.");
    assert.deepEqual(
      (graph.types.find((t) => t.id === core.uses) as unknown as { properties: { name: string }[] }).properties.map((p) => p.name),
      [...packageType(core.uses).properties.map((p) => p.name), "since"],
    );
    assert.deepEqual((edges.get(uuid(20)) as unknown as { properties: object }).properties, { since: "2020" });
  } finally {
    await wiki.dispose();
  }
});

test("personal data that does not fit the Wiki is refused before anything is written", async () => {
  const inspect = (changes: object, from = installations) =>
    inspectPersonalData({ ...context, seed: { ...seed, ...changes }, installations: from });
  await assert.rejects(inspect({ localOrganizations: [] }), /not a supported Wiki file/);
  await assert.rejects(inspect({ format: "outfitter-graph-entities-v2" }), /not a supported Wiki file/);
  await inspect({ nodes: [...seed.nodes, node(uuid(4), core.project, "External project")] });
  await assert.rejects(inspect({ projects: [node(uuid(12), core.technology, "Not a project")] }), /is not a Project/);
  await assert.rejects(inspect({}, { "wiki-map": installations["wiki-map"] } as typeof installations), /no personal Planning installation/);
  await assert.rejects(
    inspect({ nodes: [{ ...seed.nodes[0], source: { installationId: "x", type: "person", id: "y" } }] }),
    /references another app's record/,
  );
  // A property no definition declares, not even the saved one, is refused.
  await assert.rejects(
    inspect({ edges: [{ ...seed.edges[0], properties: { undeclared: "active" } }] }),
    /relationship .* \(uses\): Unknown property: undeclared/,
  );
  await assert.rejects(
    inspect({ types: [...seed.types, type(uuid(91), "node", "Hobby")] }),
    /repeats a type name/,
  );
  await assert.rejects(inspect({ edges: [edge(24, uuid(1), uuid(99))] }), /references a missing node/);
  await assert.rejects(inspect({ edges: [...seed.edges, edge(25, uuid(1), uuid(2))] }), /repeats a relationship/);
});

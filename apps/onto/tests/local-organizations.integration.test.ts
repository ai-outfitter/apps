import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { core } from "../src/lib/graph";
import {
  SEED_FORMAT,
  SNAPSHOT_FORMAT,
  inspectLocalData,
  seedLocalInstallation,
} from "../scripts/local-seed";

// Synthetic records only. Real exports stay in the ignored private data directory.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const type = (id: string, category: "node" | "edge", name: string) => ({
  id, category, name, title: name, body: `${name} records.`, properties: [], archived: false,
  ...(category === "edge" ? { ontology: { version: 2 as const, endpoints: { from: "any" as const, to: "any" as const } } } : {}),
});
const types = [
  type(core.organization, "node", "Organization"),
  type(core.offering, "node", "Offering"),
  type(core.technology, "node", "Technology"),
  type(core.project, "node", "Project"),
  type(core.offeredBy, "edge", "offered_by"),
  type(core.uses, "edge", "uses"),
];
const node = (id: number, typeId: string, title: string, extra = {}) => ({
  id: uuid(id), typeId, title, slug: title.toLowerCase().replaceAll(" ", "-"), summary: "", body: "",
  website: null, properties: {}, archived: false, ...extra,
});
const edge = (id: number, typeId: string, from: number, to: number) => ({
  id: uuid(id), typeId, fromId: uuid(from), toId: uuid(to), title: "", body: "", properties: {}, archived: false,
});
const seed = {
  format: SEED_FORMAT,
  types,
  nodes: [
    node(1, core.organization, "Alpha Local"),
    node(2, core.organization, "Beta Local"),
    node(3, core.offering, "Beta Offering"),
    node(4, core.technology, "Beta Stack"),
    node(5, core.organization, "Unrelated Local"),
    node(6, core.project, "Beta Plan"),
  ],
  projects: [],
  edges: [edge(20, core.offeredBy, 3, 2), edge(21, core.uses, 3, 4), edge(22, core.uses, 5, 4), edge(23, core.uses, 3, 6)],
  localOrganizations: [uuid(1), uuid(2)],
};
const organizations = [
  { id: "local-a", sourceId: uuid(1), slug: "alpha-local", name: "Alpha Local" },
  { id: "local-b", sourceId: uuid(2), slug: "beta-local", name: "Beta Local" },
];
// An export retains audit fields and archived records.
const snapshot = {
  format: SNAPSHOT_FORMAT,
  exportedAt: 1,
  graph: {
    canEdit: true,
    types: types.map((t) => ({ ...t, seedVersion: null, revision: 2, createdBy: "exporter", updatedBy: "exporter", createdAt: 1, updatedAt: 2 })),
    nodes: [
      node(1, core.organization, "Alpha Local", { revision: 3, createdBy: "exporter", source: null }),
      node(7, core.technology, "Alpha Archive", { archived: true }),
    ],
    edges: [{ ...edge(30, core.uses, 1, 7), archived: true }],
  },
};

const data = mkdtempSync(join(tmpdir(), "wiki-local-seed-"));
after(() => rmSync(data, { recursive: true, force: true }));
mkdirSync(join(data, "wiki-snapshots"));
writeFileSync(join(data, "wiki-snapshots/alpha-local.json"), JSON.stringify(snapshot));
writeFileSync(join(data, "wiki-snapshots/unclaimed-local.json"), JSON.stringify(snapshot));
const files = () => ["alpha-local.json", "unclaimed-local.json"].map((f) => readFileSync(join(data, "wiki-snapshots", f), "utf8"));
const original = files();
const owner = { userId: "owner", organizationId: "local-a", role: "owner" };
type Stored = { id: string; archived: boolean; revision: number; properties?: Record<string, unknown> };
const stored = async (response: Response) => {
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as { nodes: Stored[]; edges: Stored[] };
};

test("inspection plans every tenant and reports snapshots it will not load", async () => {
  const inspected = await inspectLocalData({ dataDirectory: data, seed, organizations });
  assert.deepEqual(inspected.notices, [
    "not loaded: wiki-snapshots/unclaimed-local.json matches no localOrganizations slug (file unchanged)",
  ]);
  assert.deepEqual(inspected.installations[uuid(1)], {
    source: "wiki-snapshots/alpha-local.json",
    counts: { types: 6, nodes: 2, edges: 1 },
    notices: [],
  });
  const beta = inspected.installations[uuid(2)];
  assert.equal(beta.source, SEED_FORMAT);
  // Beta, its offering and its outgoing context; never another organization or a Planning project.
  assert.deepEqual(beta.counts, { types: 6, nodes: 3, edges: 2 });
  assert.match(beta.notices.join("\n"), /skipped 1 seed projects/);
});

test("a snapshot preserves authored state and adds shared organization context without changing source files", async () => {
  const wiki = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "local-a-wiki-map");
  try {
    const report = await seedLocalInstallation({ database: wiki.database, dataDirectory: data, seed, organization: organizations[0] });
    assert.equal(report.counts.nodes, 3);
    assert.equal(report.counts.edges, 1);
    assert.ok(report.counts.types >= 6);
    const graph = await stored(await wiki.call("/api/apps/onto/graph/snapshot", owner));
    assert.deepEqual(new Set(graph.nodes.map((n) => n.id)), new Set([uuid(1), uuid(7), "004ef4f0-236f-47ba-830f-82b5780941de"]));
    assert.equal(graph.nodes.find((n) => n.id === uuid(7))?.archived, true);
    assert.equal(graph.nodes.find((n) => n.id === uuid(1))?.revision, 3);
    assert.equal(graph.nodes.find((n) => n.id === uuid(1))?.properties?.organization_id, "local-a");
    assert.deepEqual(files(), original);
    assert.equal(graph.edges[0].archived, true);
  } finally {
    await wiki.dispose();
  }
});

test("without a snapshot the organization's projection is added to the package defaults", async () => {
  const wiki = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "local-b-wiki-map");
  try {
    assert.equal((await wiki.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
    const before = (await stored(await wiki.call("/api/apps/onto/graph/snapshot", owner))).nodes.length;
    const report = await seedLocalInstallation({ database: wiki.database, dataDirectory: data, seed, organization: organizations[1] });
    assert.equal(report.counts.nodes, before + 3);
    const ids = (await stored(await wiki.call("/api/apps/onto/graph/snapshot", owner))).nodes.map((n) => n.id);
    assert.ok(!ids.includes(uuid(5)) && !ids.includes(uuid(6)));
  } finally {
    await wiki.dispose();
  }
});

test("unsupported or inconsistent files are rejected and source files are never changed", async () => {
  const bad = mkdtempSync(join(tmpdir(), "wiki-local-seed-bad-"));
  try {
    mkdirSync(join(bad, "wiki-snapshots"));
    const write = (value: unknown) => writeFileSync(join(bad, "wiki-snapshots/alpha-local.json"), JSON.stringify(value));
    const inspect = () => inspectLocalData({ dataDirectory: bad, seed, organizations });
    write({ ...snapshot, format: "outfitter-wiki-graph-v2" });
    await assert.rejects(inspect, /not a supported Wiki file/);
    write({ ...snapshot, graph: { ...snapshot.graph, nodes: [{ ...snapshot.graph.nodes[0], color: "red" }] } });
    await assert.rejects(inspect, /not a supported Wiki file/);
    write({ ...snapshot, graph: { ...snapshot.graph, nodes: [snapshot.graph.nodes[0]] } });
    await assert.rejects(inspect, /references a missing node/);
    await assert.rejects(
      inspectLocalData({ dataDirectory: data, seed: { ...seed, format: "other" }, organizations }),
      /organizations.local.json is not a supported/,
    );
    await assert.rejects(
      inspectLocalData({ dataDirectory: data, seed, organizations: [{ ...organizations[0], sourceId: uuid(3) }] }),
      /must name an active Organization/,
    );
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
  assert.deepEqual(files(), original);
});


test("app-owned Wiki seeds accept optional slugs without changing saved addresses or source files", async () => {
  const wiki = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "local-a-wiki-map");
  const supplement = join(data, "app-owned-seed.mjs");
  const records = [
    { id: uuid(101), typeId: core.technology, title: "Alpha Local" },
    { id: uuid(102), typeId: core.technology, title: "Alpha Local" },
    { id: uuid(103), typeId: core.technology, title: "Explicit address", slug: "stable-address" },
  ];
  const contents = `export const graph = ${JSON.stringify({ types: [], nodes: records, edges: [] })};`;
  writeFileSync(supplement, contents);
  try {
    const load = () => seedLocalInstallation({ database: wiki.database, dataDirectory: data, seed, organization: organizations[0], wikiSeeds: [supplement] });
    await load();
    const snapshot = async () => (await (await wiki.call("/api/apps/onto/graph/snapshot", owner)).json()) as { nodes: { id: string; slug: string }[] };
    const first = (await snapshot()).nodes.filter(node => records.some(record => record.id === node.id));
    assert.deepEqual(first.map(node => node.slug).sort((a, b) => a.localeCompare(b)), ["alpha-local-2", "alpha-local-3", "stable-address"]);
    await load();
    assert.deepEqual((await snapshot()).nodes.filter(node => records.some(record => record.id === node.id)).map(({ id, slug }) => ({ id, slug })), first.map(({ id, slug }) => ({ id, slug })));
    assert.equal(readFileSync(supplement, "utf8"), contents);
    assert.deepEqual(files(), original);
  } finally {
    await wiki.dispose();
  }
});

test("explicit local organization binding preserves archived nodes and conflicting saved identity", async () => {
  for (const archived of [true, false]) {
    const directory = mkdtempSync(join(tmpdir(), "wiki-explicit-binding-"));
    const wiki = await appWorker(
      "onto",
      appArtifact(new URL("..", import.meta.url), "operational"),
      `binding-${archived}`,
    );
    try {
      mkdirSync(join(directory, "wiki-snapshots"));
      const saved = {
        ...snapshot,
        graph: {
          ...snapshot.graph,
          types: snapshot.graph.types.map((t) => ({
            ...t,
            properties:
              t.id === core.organization
                ? [
                    {
                      name: "organization_id",
                      type: "string",
                      description: "Explicit platform identity",
                      required: false,
                    },
                  ]
                : t.properties,
          })),
          nodes: snapshot.graph.nodes.map((n) =>
            n.id === uuid(1)
              ? {
                  ...n,
                  archived,
                  properties: archived
                    ? {}
                    : { organization_id: "saved-other-organization" },
                }
              : n,
          ),
        },
      };
      const path = join(directory, "wiki-snapshots/alpha-local.json");
      const originalSource = JSON.stringify(saved);
      writeFileSync(path, originalSource);
      const report = await seedLocalInstallation({
        database: wiki.database,
        dataDirectory: directory,
        seed,
        organization: organizations[0],
      });
      const graph = await stored(
        await wiki.call("/api/apps/onto/graph/snapshot", owner),
      );
      const organization = graph.nodes.find((n) => n.id === uuid(1));
      assert.equal(organization?.archived, archived);
      assert.equal(organization?.revision, 3);
      assert.equal(
        organization?.properties?.organization_id,
        archived ? undefined : "saved-other-organization",
      );
      if (!archived)
        assert.match(report.notices.join(" "), /binding preserved/);
      assert.equal(readFileSync(path, "utf8"), originalSource);
    } finally {
      await wiki.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("Wiki restores only verified same-organization Planning source references and preserves snapshot identities", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wiki-local-planning-links-"));
  const organization = organizations[0];
  const exportedPlanning = uuid(70),
    foreignPlanning = uuid(71),
    projectId = uuid(80);
  const localSnapshot = {
    ...snapshot,
    graph: {
      ...snapshot.graph,
      nodes: [
        ...snapshot.graph.nodes,
        node(40, core.project, "Matched Planning project", {
          revision: 7,
          source: {
            installationId: exportedPlanning,
            type: "project",
            id: projectId,
          },
        }),
        node(41, core.project, "Unmatched Planning project", {
          revision: 8,
          source: {
            installationId: exportedPlanning,
            type: "project",
            id: uuid(81),
          },
        }),
        node(42, core.project, "Foreign Planning project", {
          revision: 9,
          source: {
            installationId: foreignPlanning,
            type: "project",
            id: projectId,
          },
        }),
        node(43, core.technology, "Non-project reference", {
          revision: 10,
          source: {
            installationId: exportedPlanning,
            type: "project",
            id: uuid(82),
          },
        }),
      ],
    },
  };
  const wiki = await appWorker(
    "onto",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "local-planning-links-wiki",
  );
  try {
    mkdirSync(join(directory, "wiki-snapshots"), { recursive: true });
    const wikiPath = join(
      directory,
      "wiki-snapshots",
      `${organization.slug}.json`,
    );
    writeFileSync(wikiPath, JSON.stringify(localSnapshot));
    const beforeWiki = readFileSync(wikiPath, "utf8");
    const absent = await seedLocalInstallation({
      database: wiki.database,
      dataDirectory: directory,
      seed,
      organization,
    });
    assert.match(
      absent.notices.join("\n"),
      /no app-snapshots\/alpha-local\/planning.json; preserved 3 Project references/,
    );
    type ProjectView = {
      id: string;
      revision?: number;
      source?: { installationId: string; type: string; id: string } | null;
    };
    let stored = (await (
      await wiki.call("/api/apps/onto/graph/snapshot", owner)
    ).json()) as { nodes: ProjectView[] };
    assert.equal(
      stored.nodes.find((n) => n.id === uuid(40))?.source?.installationId,
      exportedPlanning,
    );
    mkdirSync(join(directory, "app-snapshots", organization.slug), {
      recursive: true,
    });
    const planningPath = join(
      directory,
      "app-snapshots",
      organization.slug,
      "planning.json",
    );
    const planningSnapshot = {
      format: "outfitter-planning-local-v1",
      sourceInstallationId: exportedPlanning,
      projects: [
        { id: projectId, name: "Canonical counterpart" },
        { id: uuid(82), name: "Non-project counterpart must stay untouched" },
      ],
      issues: [],
    };
    writeFileSync(planningPath, JSON.stringify(planningSnapshot));
    const beforePlanning = readFileSync(planningPath, "utf8");
    const linked = await seedLocalInstallation({
      database: wiki.database,
      dataDirectory: directory,
      seed,
      organization,
    });
    assert.match(
      linked.notices.join("\n"),
      /remapped 1 verified Project references/,
    );
    assert.match(
      linked.notices.join("\n"),
      /preserved 2 unmatched or foreign Project references/,
    );
    stored = (await (
      await wiki.call("/api/apps/onto/graph/snapshot", owner)
    ).json()) as typeof stored;
    const matched = stored.nodes.find((n) => n.id === uuid(40));
    assert.deepEqual(matched?.source, {
      installationId: `local-${organization.sourceId}-planning`,
      type: "project",
      id: projectId,
    });
    assert.equal(matched?.revision, 7);
    for (const n of [41, 42, 43])
      assert.deepEqual(
        stored.nodes.find((node) => node.id === uuid(n))?.source,
        (
          localSnapshot.graph.nodes.find(
            (node) => node.id === uuid(n),
          ) as ProjectView
        )?.source,
      );
    assert.equal(readFileSync(wikiPath, "utf8"), beforeWiki);
    assert.equal(readFileSync(planningPath, "utf8"), beforePlanning);
  } finally {
    await wiki.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an explicitly mapped local organization can bind its unique older snapshot slug",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"wiki-slug-binding-"));
  const wiki=await appWorker("onto",appArtifact(new URL("..",import.meta.url),"operational"),"slug-binding");
  try {
    mkdirSync(join(directory,"wiki-snapshots"));
    const saved={...snapshot,graph:{...snapshot.graph,nodes:snapshot.graph.nodes.map(row=>row.id===uuid(1)?{...row,id:uuid(99)}:row),edges:snapshot.graph.edges.map(row=>row.fromId===uuid(1)?{...row,fromId:uuid(99)}:row)}};
    const path=join(directory,"wiki-snapshots","alpha-local.json");const contents=JSON.stringify(saved);writeFileSync(path,contents);
    await seedLocalInstallation({database:wiki.database,dataDirectory:directory,seed,organization:organizations[0]});
    const graph=await stored(await wiki.call("/api/apps/onto/graph/snapshot",owner));
    assert.equal(graph.nodes.find(row=>row.id===uuid(99))?.properties?.organization_id,"local-a");
    assert.equal(readFileSync(path,"utf8"),contents);
  }finally{await wiki.dispose();rmSync(directory,{recursive:true,force:true});}
});

test("legacy snapshot contracts reconcile with preserved prior revisions and identical restart receipts",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"legacy-local-ontology-"));
 mkdirSync(join(directory,"wiki-snapshots"));
 const legacy=structuredClone(snapshot);
 for(const type of legacy.graph.types)if(type.category==="edge")delete (type as {ontology?:unknown}).ontology;
 const path=join(directory,"wiki-snapshots",`${organizations[0].slug}.json`),original=JSON.stringify(legacy);
 writeFileSync(path,original);
 const wiki=await appWorker("onto",appArtifact(new URL("..",import.meta.url),"operational"),"legacy-local-onto");
 try{
  const first=await seedLocalInstallation({database:wiki.database,dataDirectory:directory,seed,organization:organizations[0]});
  assert.match(first.notices.join("\n"),/canonical Wiki migration/);
  const history=await wiki.database.prepare("SELECT recordId,revision,prior,snapshot FROM graph_revisions WHERE ref='wiki-onto-contract' ORDER BY recordId").all<{recordId:string;revision:number;prior:string;snapshot:string}>();
  assert.equal(history.results.length,2);
  assert.equal(JSON.parse(history.results[0].prior).ontology,undefined);
  assert.equal(JSON.parse(history.results[0].prior).revision,2);
  assert.equal(JSON.parse(history.results[0].snapshot).revision,3);
  const before=JSON.stringify(history.results);
  await seedLocalInstallation({database:wiki.database,dataDirectory:directory,seed,organization:organizations[0]});
  const repeated=await wiki.database.prepare("SELECT recordId,revision,prior,snapshot FROM graph_revisions WHERE ref='wiki-onto-contract' ORDER BY recordId").all();
  assert.equal(JSON.stringify(repeated.results),before);
  assert.equal(readFileSync(path,"utf8"),original);
 } finally {await wiki.dispose();rmSync(directory,{recursive:true,force:true});}
});

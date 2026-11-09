/** Wiki's local seed adapter for `node scripts/dev-local.mjs`. Node-only; never
 * imported by app pages or packaged workers. Each organization's Wiki is rebuilt
 * exactly from its own exported snapshot, or projected from the private seed when
 * it has none. The viewer's personal Wiki restores the whole personal graph.
 * Nothing here writes to the data directory. */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { entityRef } from "@ai-outfitter/app-sdk/entities";
import { appRecordKey } from "@ai-outfitter/app-sdk/graph-contracts";
import type { appWorker } from "@ai-outfitter/app-test/worker";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import releaseExample from "../seeds/release-example-v1.json";
import { defaultEdges, defaultEntities } from "../src/lib/default-entities";
import { defaultTypes } from "../src/lib/default-types";
import { seedDocument } from "../src/lib/entity-import";
import {
  core,
  edgeInput,
  freeSlug,
  nodeInput,
  slugify,
  typeInput,
  validateProperties,
  type Graph as WikiGraph,
} from "../src/lib/graph";
import { validateKnowledgeGraph } from "../src/lib/knowledge-graph-document";
import { storeType } from "../src/lib/type-metadata";
import { readGraph } from "../src/server/graph";
import { standardData } from "../src/lib/standard-data";
import {refreshKnowledgeGraphQueries} from "../src/server/knowledge-graph-refresh";
import { setupStandardData } from "../src/server/standard-data";

export const SNAPSHOT_FORMAT = "outfitter-wiki-graph-v1";
export const SEED_FORMAT = "outfitter-graph-entities-v1";
export const SNAPSHOT_DIRECTORY = "wiki-snapshots";
export const PERSONAL_SEED_FILE = "personal.local.json";
/** The personal installation that owns canonical projects; Project pages reference it. */
export const PROJECT_PUBLISHER = "planning";

type Database = Awaited<ReturnType<typeof appWorker>>["database"];
async function setupDefaults(database: Database, data = standardData) {
  return setupStandardData({
    query: async ({ sql, params }) => (await database.prepare(sql).bind(...(params ?? [])).all<Record<string, unknown>>()).results,
    batch: async (statements) => database.batch(statements.map(({ sql, params }) => database.prepare(sql).bind(...(params ?? [])))),
  }, { userId: "local-seed", installationId: "local-wiki", owner: { kind: "user", id: "local-seed" }, role: "owner", canEdit: true }, data);
}

type Organization = { id: string; sourceId: string; slug: string; name: string };
type Context = { dataDirectory: string; seed: unknown; organizations: Organization[] };
type WikiSeedContext = { dataDirectory: string; organization: Organization };
type WikiSeed = {
  source?: string;
  graph?: unknown;
  loadLocalWikiSeed?: (
    context: WikiSeedContext,
  ) => Promise<{ source?: string; graph: unknown }>;
};

// Export metadata is optional so a seed and a backup share one record shape.
// Records are strict: a field this version does not store fails instead of being dropped.
const audit = {
  revision: z.number().int().positive().optional(),
  createdBy: z.string().nullable().optional(),
  updatedBy: z.string().nullable().optional(),
  createdAt: z.number().int().optional(),
  updatedAt: z.number().int().optional(),
};
const typeRecord = typeInput.extend({
  id: z.uuid(),
  seedVersion: z.number().int().nullable().optional(),
  ...audit,
});
const nodeRecord = nodeInput.extend({
  id: z.uuid(),
  slug: nodeInput.shape.slug.unwrap(),
  source: entityRef.nullable().optional(),
  ...audit,
});
const edgeRecord = edgeInput.extend({ id: z.uuid(), ...audit });
const graph = z.object({
  types: z.array(typeRecord),
  nodes: z.array(nodeRecord),
  edges: z.array(edgeRecord),
});
type Graph = z.infer<typeof graph>;
// Top-level backup metadata (notes, transfer copy, origin) is derived from `graph`.
const snapshotFile = z.looseObject({
  format: z.literal(SNAPSHOT_FORMAT),
  graph: graph.extend({ canEdit: z.boolean().optional() }),
});
const seedFile = graph.extend({
  format: z.literal(SEED_FORMAT),
  projects: z.array(nodeRecord.partial({ slug: true })).default([]),
  nodes: z.array(nodeRecord.partial({ slug: true })),
  localOrganizations: z.array(z.string()),
});
type Seed = z.infer<typeof seedFile>;
// The viewer's whole graph. Planning-linked project pages are listed apart;
// standalone external projects remain in nodes. Strict at every level: nothing unknown is dropped.
const personalFile = z.strictObject({
  format: z.literal(SEED_FORMAT),
  types: z.array(typeRecord),
  nodes: z.array(nodeRecord.partial({ slug: true })),
  projects: z.array(nodeRecord.partial({ slug: true })).default([]),
  edges: z.array(edgeRecord),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string) {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error(`${label} is not a supported Wiki file: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Every reference resolves inside the file and every key is unique, as the Wiki schema requires. */
function validateGraph(data: Graph, label: string) {
  const unique = (values: string[], what: string) => {
    if (new Set(values).size !== values.length) throw new Error(`${label} repeats a ${what}`);
  };
  unique(data.types.map((t) => t.id), "type ID");
  unique(data.types.map((t) => t.name), "type name");
  unique(data.nodes.map((n) => n.id), "node ID");
  unique(data.nodes.map((n) => n.slug), "node slug");
  unique(data.edges.map((e) => e.id), "relationship ID");
  unique(data.edges.map((e) => `${e.typeId}:${e.fromId}:${e.toId}`), "relationship");
  const types = new Map(data.types.map((t) => [t.id, t]));
  const nodes = new Set(data.nodes.map((n) => n.id));
  const properties = (record: string, type: Graph["types"][number], values: Record<string, unknown>) => {
    try {
      validateProperties(type, values as Parameters<typeof validateProperties>[1]);
    } catch (error) {
      throw new Error(`${label}: ${record} (${type.name}): ${(error as Error).message}`);
    }
  };
  for (const node of data.nodes) {
    const type = types.get(node.typeId);
    if (type?.category !== "node") throw new Error(`${label}: node ${node.id} has an unknown node type`);
    properties(`node ${node.id}`, type, node.properties);
  }
  for (const edge of data.edges) {
    const type = types.get(edge.typeId);
    if (type?.category !== "edge") throw new Error(`${label}: relationship ${edge.id} has an unknown relationship type`);
    if (!nodes.has(edge.fromId) || !nodes.has(edge.toId))
      throw new Error(`${label}: relationship ${edge.id} references a missing node`);
    properties(`relationship ${edge.id}`, type, edge.properties);
  }
}

function parseSeed(value: unknown) {
  const seed = parse(seedFile, value, "organizations.local.json");
  const taken = new Set(seed.nodes.flatMap((n) => (n.slug ? [n.slug] : [])));
  return {
    ...seed,
    nodes: seed.nodes.map((n) => ({ ...n, slug: n.slug ?? freeSlug(slugify(n.title), taken) })),
  };
}

/** Add every node reachable through outgoing relationships. */
function expandOutgoing(selected: Set<string>, edges: Graph["edges"]) {
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of edges)
      if (selected.has(e.fromId) && !selected.has(e.toId)) {
        selected.add(e.toId);
        changed = true;
      }
  }
}

/** The organization's offerings, role assignments, customers and outgoing context.
 * Employment, reporting lines and contacts are never inferred. */
export function organizationProjection(seed: Omit<Seed, "nodes"> & { nodes: Graph["nodes"] }, organizationId: string): Graph {
  const nodes = new Map(seed.nodes.filter((n) => !n.archived).map((n) => [n.id, n]));
  const edges = seed.edges.filter((e) => !e.archived);
  const from = (typeId: string, test: (e: Graph["edges"][number]) => boolean, nodeType?: string) =>
    edges.filter((e) => e.typeId === typeId && test(e) && (!nodeType || nodes.get(e.fromId)?.typeId === nodeType)).map((e) => e.fromId);
  const offerings = new Set(from(core.offeredBy, (e) => e.toId === organizationId));
  const selected = new Set([
    organizationId,
    ...offerings,
    ...from(core.scopedTo, (e) => e.toId === organizationId, core.roleAssignment),
  ]);
  expandOutgoing(selected, edges);
  const additions = [
    // Segments that experience this organization's documented problems.
    ...from(core.experiences, (e) => selected.has(e.toId), core.customerSegment),
    // Customers: explicit `customer_of`, or a purchase of one of its offerings.
    ...from(core.customerOf, (e) => e.toId === organizationId, core.organization),
    ...from(core.paysFor, (e) => offerings.has(e.toId), core.organization),
  ];
  for (const id of additions) selected.add(id);
  const kept = [...nodes.values()].filter((n) => selected.has(n.id) && n.typeId !== core.project);
  const ids = new Set(kept.map((n) => n.id));
  return {
    types: seed.types,
    nodes: kept,
    edges: edges.filter((e) => ids.has(e.fromId) && ids.has(e.toId)),
  };
}

async function snapshotFiles(dataDirectory: string) {
  try {
    return (await readdir(join(dataDirectory, SNAPSHOT_DIRECTORY))).filter((file) => file.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const counts = (data: Graph) => ({
  types: data.types.length,
  nodes: data.nodes.length,
  edges: data.edges.length,
});

/** Only a same-organization Planning backup proves which exported references have
 * canonical local counterparts. Never infer identity from a title or Wiki node ID. */
async function localPlanningReferences(
  dataDirectory: string,
  organization: Organization,
  data: Graph,
  notices: string[],
) {
  const projects = data.nodes.filter((n) => n.typeId === core.project);
  if (!projects.length) return data;
  const label = `app-snapshots/${organization.slug}/planning.json`;
  let raw: string;
  try {
    raw = await readFile(join(dataDirectory, label), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    notices.push(
      `no ${label}; preserved ${projects.length} Project references because no local Planning counterpart is verified`,
    );
    return data;
  }
  // Read only the identity fields; Planning owns validation and restoration of its
  // full project/issue documents. No saved file or authored graph field is edited.
  const index = z
    .object({
      format: z.literal("outfitter-planning-local-v1"),
      sourceInstallationId: z.uuid(),
      projects: z.array(z.object({ id: z.uuid() })),
    })
    .safeParse(JSON.parse(raw));
  if (!index.success)
    throw new Error(
      `${label} is not a supported Planning reference snapshot: ${z.prettifyError(index.error)}`,
    );
  const ids = new Set(index.data.projects.map((project) => project.id));
  if (ids.size !== index.data.projects.length)
    throw new Error(`${label} repeats a project ID`);
  let remapped = 0;
  const nodes = data.nodes.map((node) => {
    if (
      node.typeId !== core.project ||
      node.source?.type !== "project" ||
      node.source.installationId !== index.data.sourceInstallationId ||
      !ids.has(node.source.id)
    )
      return node;
    remapped++;
    return {
      ...node,
      source: {
        ...node.source,
        installationId: `local-${organization.sourceId}-planning`,
      },
    };
  });
  if (remapped)
    notices.push(
      `remapped ${remapped} verified Project references to local Planning; source IDs and graph revisions are unchanged`,
    );
  const preserved = projects.length - remapped;
  if (preserved)
    notices.push(
      `preserved ${preserved} unmatched or foreign Project references; no same-source local Planning counterpart is verified`,
    );
  return { ...data, nodes };
}

async function plan(dataDirectory: string, seed: ReturnType<typeof parseSeed>, organization: Organization, files: string[]) {
  const org = seed.nodes.find((n) => n.id === organization.sourceId);
  if (!org || org.archived || org.typeId !== core.organization)
    throw new Error(`localOrganizations entry ${organization.sourceId} must name an active Organization`);
  const notices: string[] = [];
  const file = `${organization.slug}.json`;
  if (files.includes(file)) {
    const label = `${SNAPSHOT_DIRECTORY}/${file}`;
    const raw = JSON.parse(await readFile(join(dataDirectory, SNAPSHOT_DIRECTORY, file), "utf8"));
    const { graph: data } = parse(snapshotFile, raw, label);
    validateGraph(data, label);
    const linked = await localPlanningReferences(dataDirectory, organization, data, notices);
    return { source: label, mode: "replace" as const, graph: linked, notices };
  }
  const data = organizationProjection(seed, org.id);
  validateGraph(data, `${organization.slug} projection`);
  notices.push(`no ${SNAPSHOT_DIRECTORY}/${file}; projected ${data.nodes.length} of ${seed.nodes.length} seed records`);
  const skipped = seed.projects.length + seed.nodes.filter((n) => n.typeId === core.project).length;
  if (skipped)
    notices.push(`skipped ${skipped} seed projects: canonical project creation belongs to Planning and is not seeded`);
  return { source: SEED_FORMAT, mode: "merge" as const, graph: data, notices };
}

/** Validate the private data for every organization without writing anything. */
export async function inspectLocalData({ dataDirectory, seed, organizations }: Context) {
  const parsed = parseSeed(seed);
  const files = await snapshotFiles(dataDirectory);
  const installations: Record<string, { source: string; counts: Record<string, number>; notices: string[] }> = {};
  for (const organization of organizations) {
    const result = await plan(dataDirectory, parsed, organization, files);
    installations[organization.sourceId] = { source: result.source, counts: counts(result.graph), notices: result.notices };
  }
  const claimed = new Set(organizations.map((org) => `${org.slug}.json`));
  // A snapshot that matches no tenant is reported, never silently ignored. It stays untouched.
  const notices = files
    .filter((file) => !claimed.has(file))
    .map((file) => `not loaded: ${SNAPSHOT_DIRECTORY}/${basename(file)} matches no localOrganizations slug (file unchanged)`);
  return { installations, notices };
}

/** One D1 batch per table set: all rows or none. JSON binding keeps each statement under D1's parameter limit.
 * With `upsert`, a record replaces the stored record with the same ID. */
function insertAll(database: Database, data: Graph, upsert = false) {
  const now = Date.now();
  const row = <T extends object>(record: T) => ({
    revision: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: now,
    updatedAt: now,
    ...record,
  });
  const types = data.types.map((t) => storeType(row({ seedVersion: null, ...t })));
  const nodes = data.nodes.map((n) => row({ source: null, ...n }));
  const edges = data.edges.map((e) => row(e));
  const insert = (table: string, columns: string[], rows: object[]) =>
    database
      .prepare(
        `INSERT INTO ${table} (${columns.join(",")}) SELECT ${columns
          .map((c) => `json_extract(value,'$.${c}')`)
          .join(",")} FROM json_each(?)${
          // `WHERE true` resolves SQLite's INSERT … SELECT … ON CONFLICT ambiguity.
          upsert
            ? ` WHERE true ON CONFLICT(id) DO UPDATE SET ${columns
                .filter((c) => c !== "id")
                .map((c) => `${c}=excluded.${c}`)
                .join(",")}`
            : ""
        }`,
      )
      .bind(JSON.stringify(rows));
  const audited = ["archived", "revision", "createdBy", "updatedBy", "createdAt", "updatedAt"];
  return [
    insert("graph_types", ["id", "category", "name", "title", "body", "properties", "seedVersion", ...audited], types),
    insert("graph_nodes", ["id", "typeId", "slug", "title", "summary", "body", "website", "properties", "externalKey", ...audited],
      nodes.map((n) => ({ ...n, externalKey: n.source ? appRecordKey(n.source) : null }))),
    insert("graph_edges", ["id", "typeId", "fromId", "toId", "title", "body", "properties", ...audited], edges),
  ];
}

async function ids(database: Database, table: string, column = "id") {
  const { results } = await database.prepare(`SELECT ${column} AS value FROM ${table}`).all<{ value: string }>();
  return new Set(results.map((r) => r.value));
}

async function appOwnedWikiSeeds(paths: string[], context: WikiSeedContext, database: Database) {
  const { results } = await database.prepare("SELECT id, slug FROM graph_nodes").all<{ id: string; slug: string }>();
  const savedSlugs = new Map(results.map(node => [node.id, node.slug]));
  const taken = new Set(savedSlugs.values());
  const graphs: { source: string; graph: Graph }[] = [];
  for (const path of paths) {
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(path).href
    )) as WikiSeed;
    const loaded = module.loadLocalWikiSeed
      ? await module.loadLocalWikiSeed(context)
      : { source: module.source, graph: module.graph };
    const source = loaded.source ?? path;
    // App-owned graphs use the SDK input contract, where slugs are optional.
    // Resolve missing slugs here, preserving stored IDs and explicit addresses.
    const data = parse(graph.extend({ nodes: z.array(nodeRecord.partial({ slug: true })) }), loaded.graph, source);
    for (const node of data.nodes) if (node.slug) taken.add(node.slug);
    const nodes = data.nodes.map(node => ({
      ...node,
      slug: node.slug ?? savedSlugs.get(node.id) ?? freeSlug(slugify(node.title), taken),
    }));
    graphs.push({ source, graph: { ...data, nodes } });
  }
  return graphs;
}

/** Runtime-only context from the explicit localOrganizations mapping. Source
 * snapshots stay untouched, and every other field/revision remains preserved. */
function localOrganizationBinding(
  data: Graph,
  organization: Organization,
  notices: string[],
): Graph {
  const exact = data.nodes.find(n => n.id === organization.sourceId && n.typeId === core.organization && !n.archived);
  // Private Wiki snapshots can predate the platform seed's Organization UUID.
  // The explicitly provisioned local slug may bind a single matching root;
  // ambiguous roots and existing bindings retain their ordinary refusal rules.
  const matches = data.nodes.filter(n => n.slug === organization.slug && n.typeId === core.organization && !n.archived);
  const node = exact ?? (matches.length === 1 ? matches[0] : undefined);
  const type = data.types.find(
    (t) =>
      t.id === core.organization && t.name === "Organization" && !t.archived,
  );
  if (!node || !type) return data;
  const current = node.properties.organization_id;
  if (current === organization.id) return data;
  if (current !== undefined && current !== "") {
    notices.push(
      "Organization binding preserved: the saved organization_id differs from the explicit local mapping; select context explicitly",
    );
    return data;
  }
  const property = defaultTypes
    .find((t) => t.id === core.organization)
    ?.properties.find((p) => p.name === "organization_id");
  if (!property)
    throw new Error("Standard Organization binding property is missing");
  const existing = type.properties.find((p) => p.name === property.name);
  if (existing && existing.type !== "string")
    throw new Error("Organization binding property must be a string");
  const bound = {
    ...data,
    types: data.types.map((t) =>
      t.id === type.id && !existing
        ? { ...t, properties: [...t.properties, property] }
        : t,
    ),
    nodes: data.nodes.map((n) =>
      n.id === node.id
        ? {
            ...n,
            properties: { ...n.properties, organization_id: organization.id },
          }
        : n,
    ),
  };
  validateGraph(bound, "explicit local organization binding");
  notices.push(
    "derived Organization organization_id from the explicit localOrganizations mapping; source files and graph revisions are unchanged",
  );
  return bound;
}

/** Seed one fresh installation and verify every planned record is stored. */
export async function seedLocalInstallation({
  database,
  dataDirectory,
  seed,
  organization,
  wikiSeeds,
}: Omit<Context, "organizations"> & {
  database: Database;
  organization: Organization;
  wikiSeeds?: string[];
}) {
  const planned = await plan(dataDirectory, parseSeed(seed), organization, await snapshotFiles(dataDirectory));
  await setupDefaults(database);
  const notices = [...planned.notices];
  let data = localOrganizationBinding(planned.graph, organization, notices);
  if (planned.mode === "replace") {
    // Restore authored state, then add only reusable overview definitions below.
    await database.batch([
      database.prepare("DELETE FROM graph_assets"),
      database.prepare("DELETE FROM graph_edges"),
      database.prepare("DELETE FROM graph_nodes"),
      database.prepare("DELETE FROM graph_types"),
      ...insertAll(database, data),
    ]);
  } else {
    // A projection adds to the package's defaults; matching IDs keep the stored record.
    const [typeIds, typeNames, nodeIds, slugs, edgeIds] = await Promise.all([
      ids(database, "graph_types"),
      ids(database, "graph_types", "name"),
      ids(database, "graph_nodes"),
      ids(database, "graph_nodes", "slug"),
      ids(database, "graph_edges"),
    ]);
    const types = data.types.filter((t) => !typeIds.has(t.id));
    const nodes = data.nodes.filter((n) => !nodeIds.has(n.id));
    if (types.some((t) => typeNames.has(t.name)) || nodes.some((n) => slugs.has(n.slug)))
      throw new Error(`${organization.slug}: seed type names or slugs collide with package defaults under different IDs`);
    const kept = data.types.length - types.length + data.nodes.length - nodes.length;
    if (kept) notices.push(`${kept} seed types or nodes already exist as package defaults; the stored definitions were kept`);
    data = { types, nodes, edges: data.edges.filter((e) => !edgeIds.has(e.id)) };
    await database.batch(insertAll(database, data));
  }
  for (const supplement of await appOwnedWikiSeeds(wikiSeeds ?? [], {
    dataDirectory,
    organization,
  }, database)) {
    const [typeIds, typeNames, nodeIds, slugs, edgeIds] = await Promise.all([
      ids(database, "graph_types"),
      ids(database, "graph_types", "name"),
      ids(database, "graph_nodes"),
      ids(database, "graph_nodes", "slug"),
      ids(database, "graph_edges"),
    ]);
    // A production export already holds the app's records under its own IDs; those win,
    // and the supplement's same-named records (and their edges) are left out.
    const added = supplement.graph.types.filter((type) => !typeIds.has(type.id));
    const types = added.filter((type) => !typeNames.has(type.name));
    const typeSkipped = new Set(added.filter((type) => typeNames.has(type.name)).map((type) => type.id));
    const nodes = supplement.graph.nodes.filter((node) => !nodeIds.has(node.id) && !slugs.has(node.slug) && !typeSkipped.has(node.typeId));
    const present = new Set([...nodeIds, ...nodes.map((node) => node.id)]);
    const edges = supplement.graph.edges.filter((edge) => !edgeIds.has(edge.id) && !typeSkipped.has(edge.typeId) && present.has(edge.fromId) && present.has(edge.toId));
    const skipped = supplement.graph.types.length + supplement.graph.nodes.length + supplement.graph.edges.length
      - (supplement.graph.types.length - added.length) - types.length - nodes.length - edges.length;
    if (skipped > 0) notices.push(`${supplement.source}: ${skipped} records already saved under other IDs were kept as saved`);
    const records = { types, nodes, edges };
    await database.batch(insertAll(database, records));
    notices.push(
      `${supplement.source}: added ${records.types.length} types, ${records.nodes.length} nodes and ${records.edges.length} edges`,
    );
  }
  // A restored snapshot may predate the shared overview. Add missing standard
  // types and this one reusable definition; never fictional example entities.
  // Existing IDs, including authored or archived definitions, remain untouched.
  await setupDefaults(database, {
    ...standardData,
    nodes: standardData.nodes.filter(
      (node) => node.slug === "organization-overview",
    ),
    edges: [],
  });
  await refreshKnowledgeGraphQueries(drizzle(database));
  const [typeIds, nodeIds, edgeIds] = await Promise.all([
    ids(database, "graph_types"),
    ids(database, "graph_nodes"),
    ids(database, "graph_edges"),
  ]);
  const missing =
    planned.graph.types.filter((t) => !typeIds.has(t.id)).length +
    planned.graph.nodes.filter((n) => !nodeIds.has(n.id)).length +
    planned.graph.edges.filter((e) => !edgeIds.has(e.id)).length;
  if (missing) throw new Error(`${organization.slug}: ${missing} Wiki records were not stored`);
  return {
    source: planned.source,
    counts: { types: typeIds.size, nodes: nodeIds.size, edges: edgeIds.size },
    notices,
  };
}

type Records = Pick<Graph, "types" | "nodes" | "edges">;
type PersonalContext = { dataDirectory: string; seed: unknown; installations: Record<string, string> };

/** Order-insensitive JSON, for comparing definitions. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
const definition = (t: Graph["types"][number]) =>
  canonical({ category: t.category, name: t.name, title: t.title, body: t.body, properties: t.properties, jsonSchema: t.jsonSchema ?? null, archived: t.archived });

/** What a fresh installation stores before seeding: the package's types, entities and their relationships. */
function packageRecords(): Records {
  const nodes = defaultEntities.filter((n) => n.typeId !== core.project) as Graph["nodes"];
  const ids = new Set(nodes.map((n) => n.id));
  return {
    types: defaultTypes as Graph["types"],
    nodes,
    edges: defaultEdges.filter((e) => ids.has(e.fromId) && ids.has(e.toId)),
  };
}

/** Planning-linked projects are listed apart; standalone project nodes need no app reference. */
function checkPlacement(seed: z.infer<typeof personalFile>, planning: string | undefined) {
  const label = PERSONAL_SEED_FILE;
  const other = seed.projects.find((p) => p.typeId !== core.project);
  if (other) throw new Error(`${label}: projects entry ${other.id} is not a Project`);
  const referenced = seed.nodes.find((n) => n.source);
  if (referenced)
    throw new Error(`${label}: node ${referenced.id} references another app's record; only projects may, through Planning`);
  if (seed.projects.length && !planning)
    throw new Error(`${label} has ${seed.projects.length} projects but no personal Planning installation owns them`);
}

/** Knowledge graphs whose pattern this Wiki cannot run, by the importer's check. They are
 * restored unchanged, because a lens only reads existing relationships. */
function unsupportedLenses(graph: Records, nodes: Graph["nodes"]) {
  return nodes.filter((node) => {
    if (node.typeId !== core.knowledgeGraph) return false;
    try {
      validateKnowledgeGraph(graph as Pick<WikiGraph, "types">, node);
      return false;
    } catch {
      return true;
    }
  });
}

/** The installation's whole graph after restoring the personal seed over `stored`, the package's
 * records. Every seed record, type definitions included, replaces the package record with the same
 * ID; package records the seed lacks are kept. */
function personalPlan(value: unknown, stored: Records, installations: Record<string, string>) {
  const seed = parse(personalFile, value, PERSONAL_SEED_FILE);
  const planning = installations[PROJECT_PUBLISHER];
  checkPlacement(seed, planning);

  const seedIds = new Set([...seed.nodes, ...seed.projects].map((n) => n.id));
  const keptNodes = stored.nodes.filter((n) => !seedIds.has(n.id));
  const taken = new Set([...keptNodes, ...seed.nodes, ...seed.projects].flatMap((n) => (n.slug ? [n.slug] : [])));
  const withSlug = <T extends { slug?: string; title: string }>(n: T) => ({ ...n, slug: n.slug ?? freeSlug(slugify(n.title), taken) });
  // Each Project page references its canonical Planning record, which keeps the page's ID.
  // Exported references name the exporting environment's installation and are replaced.
  const reference = (id: string) => ({ installationId: planning, type: "project", id });
  const projects = seed.projects.map(({ source: _exported, ...p }) => withSlug({ ...p, source: reference(p.id) }));
  const remapped = seed.projects.filter((p) => p.source && canonical(p.source) !== canonical(reference(p.id))).length;
  const nodes = [...seed.nodes.map(withSlug), ...projects] as Graph["nodes"];

  // A saved definition is the viewer's, so it is restored with every field. An identical one
  // leaves the package's row, and its seed version, untouched.
  const storedTypes = new Map(stored.types.map((t) => [t.id, t]));
  const seedTypeIds = new Set(seed.types.map((t) => t.id));
  const keptTypes = stored.types.filter((t) => !seedTypeIds.has(t.id));
  const types = seed.types.filter((t) => {
    const packaged = storedTypes.get(t.id);
    return !packaged || definition(t) !== definition(packaged);
  });
  const redefined = types.filter((t) => storedTypes.has(t.id)).length;
  const edgeIds = new Set(seed.edges.map((e) => e.id));
  const keptEdges = stored.edges.filter((e) => !edgeIds.has(e.id));
  const graph = {
    types: [...keptTypes, ...seed.types],
    nodes: [...keptNodes, ...nodes],
    edges: [...keptEdges, ...seed.edges],
  };
  validateGraph(graph, PERSONAL_SEED_FILE);
  const lenses = unsupportedLenses(graph, nodes);

  const replaced = stored.nodes.length - keptNodes.length + stored.edges.length - keptEdges.length;
  const kept = keptTypes.length + keptNodes.length + keptEdges.length;
  const notices = [
    remapped && `${remapped} exported project references now point to ${planning}`,
    redefined && `${redefined} saved type definitions replace the package's`,
    replaced && `${replaced} package entities and relationships are also in the seed; the seed versions are stored`,
    kept && `${kept} package types, entities and relationships not in the seed are kept`,
    lenses.length &&
      `${lenses.length} knowledge graphs use a pattern this Wiki cannot run (${lenses.map((n) => n.id).join(", ")}); they are stored unchanged`,
  ].filter((notice): notice is string => Boolean(notice));
  return {
    graph,
    write: { types, nodes, edges: seed.edges },
    projects,
    counts: { ...counts(graph), "project pages": projects.length },
    notices,
  };
}

/** Validate `personal.local.json` against the package's records without writing anything. */
export async function inspectPersonalData({ seed, installations }: PersonalContext) {
  const planned = personalPlan(seed, packageRecords(), installations);
  return { source: PERSONAL_SEED_FILE, counts: planned.counts, notices: planned.notices };
}

/** Restore the whole personal graph into one fresh installation, then verify every record and reference. */
export async function seedPersonalInstallation({
  database,
  seed,
  installations,
  installationId,
}: PersonalContext & { database: Database; installationId: string }) {
  const identity = { userId: "local-seed", installationId, owner: { kind: "user" as const, id: "local-seed" }, role: "owner", canEdit: true };
  await setupDefaults(database);
  // Public fictional content is local/demo only. Keep it out of organization
  // snapshots and production migrations. The private personal seed still wins
  // for every identity it explicitly supplies, as with other package defaults.
  const example = seedDocument.parse(releaseExample);
  const [existingNodes, existingEdges] = await Promise.all([
    ids(database, "graph_nodes"), ids(database, "graph_edges"),
  ]);
  const additions = {
    types: [],
    nodes: example.nodes.filter((n) => !existingNodes.has(n.id)),
    edges: example.edges.filter((e) => !existingEdges.has(e.id)),
  };
  const stored = await readGraph(drizzle(database), identity);
  // Stored nodes always have a slug (NOT NULL); the shared view type leaves it optional.
  const planned = personalPlan(seed, {
    ...stored,
    nodes: [...stored.nodes as Graph["nodes"], ...additions.nodes],
    edges: [...stored.edges, ...additions.edges],
  }, installations);
  // Validate the complete plan before the first write; both sets commit together.
  await database.batch([...insertAll(database, additions), ...insertAll(database, planned.write, true)]);
  const [typeIds, nodeIds, edgeIds] = await Promise.all([
    ids(database, "graph_types"),
    ids(database, "graph_nodes"),
    ids(database, "graph_edges"),
  ]);
  const { results: sources } = await database
    .prepare("SELECT id, externalKey FROM graph_nodes WHERE externalKey IS NOT NULL")
    .all<{ id: string; externalKey: string }>();
  const references = new Map(sources.map((row) => [row.id, row.externalKey]));
  const missing =
    planned.graph.types.filter((t) => !typeIds.has(t.id)).length +
    planned.graph.nodes.filter((n) => !nodeIds.has(n.id)).length +
    planned.graph.edges.filter((e) => !edgeIds.has(e.id)).length +
    planned.projects.filter((p) => !p.source || references.get(p.id) !== appRecordKey(p.source)).length;
  const actual = { types: typeIds.size, nodes: nodeIds.size, edges: edgeIds.size };
  if (missing || canonical(actual) !== canonical(counts(planned.graph)))
    throw new Error(`personal Wiki: stored ${describe(actual)}, planned ${describe(counts(planned.graph))}; ${missing} records or references were not stored`);
  return { source: PERSONAL_SEED_FILE, counts: { ...actual, "project pages": planned.projects.length }, notices: planned.notices };
}

const describe = (c: Record<string, number>) => Object.entries(c).map(([k, v]) => `${v} ${k}`).join(", ");

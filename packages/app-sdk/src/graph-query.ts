// Bulk, byte-bounded reads over one Wiki graph: several named queries in one
// request, compact projections, counts by type and bounded expansion through the
// shared selection traversal (`selectGraph`). Domain-neutral: queries name types,
// never domain concepts. Pure and in memory over records Wiki already read, so
// retrieval can move into SQL later without changing callers.
import { z } from "zod";
import { canonicalActionValue } from "./actions";
import { graphSelectionDefinition, type GraphSelectionDefinition, selectGraph, type SelectableGraph } from "./graph-selection";
import { matchesSourceAndProperties, sourceKey } from "./graph-graphql-source";
import { isRetired } from "./knowledge-graph";
import { sha256Hex } from "./server";
import { wikiGraphRecords } from "./graph-records";
import type { WikiGraphSnapshot } from "@ai-outfitter/onto-contracts";

export const graphQueryAction = "graph.query";
const typeRef = z.string().trim().min(1).max(120);
const fieldName = z.string().min(1).max(64);
const kinds = ["node", "edge", "type"] as const;
type Kind = (typeof kinds)[number];

/** The selection a KnowledgeGraph saves, so a query can be tried, then saved unchanged. */
export const savedSelection = graphSelectionDefinition.omit({ id: true, version: true, purpose: true, rootTypes: true, maxNodes: true }).extend({
  rootTypes: z.array(typeRef).min(1).max(32).optional().describe("Node types that act as roots; defaults to each matched node's type."),
  maxNodes: z.number().int().min(1).max(500).default(100),
});
export type SavedSelection = z.infer<typeof savedSelection>;

/** The filters only a node query may carry, with the message for each one misused. */
function nodeOnlyFilters(query: { entity: string; slugs?: unknown; sources?: unknown; properties?: Record<string, unknown> }) {
  const node = query.entity === "node";
  return [
    ...(query.slugs && !node ? [["slugs", "Only node queries filter by slug"]] : []),
    ...(query.sources && !node ? [["sources", "Only node queries filter by source"]] : []),
    ...(query.properties && (!node || Object.keys(query.properties).length > 8) ? [["properties", "Only node queries filter by properties, up to 8"]] : []),
  ] as [string, string][];
}

export const graphQuery = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/).describe("Names this query's entry in the result."),
  entity: z.enum([...kinds, "all"]).default("node").describe("Records to match. \"all\" is only valid with aggregate."),
  types: z.array(typeRef).min(1).max(32).optional().describe("Node or edge type names or IDs; for entity \"type\", the type definitions themselves."),
  ids: z.array(z.string().min(1).max(200)).min(1).max(200).optional().describe("Exact record IDs."),
  slugs: z.array(z.string().min(1).max(80)).min(1).max(200).optional().describe("Node queries only: exact slugs (a node's address, unique in its Wiki)."),
  sources: z.array(z.strictObject({ installationId: z.string().min(1).max(128), type: z.string().min(1).max(128), id: z.string().min(1).max(128) })).min(1).max(100).optional()
    .describe("Node queries only: the pages whose canonical `source` is one of these app records (installation, type and id), such as a Planning project's Project page."),
  properties: z.record(z.string().min(1).max(64), z.union([z.string().max(512), z.number(), z.boolean()])).optional()
    .describe("Node queries only: stored property values that must match exactly, such as { planning_installation_id, project_id } on a use case."),
  touching: z.strictObject({
    nodeIds: z.array(z.string().min(1).max(200)).min(1).max(200),
    direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
  }).optional().describe("Edge queries only: edges leaving (outgoing), entering (incoming) or touching (both) these nodes."),
  text: z.string().trim().min(1).max(256).optional().describe("Case-insensitive literal substring across IDs, titles, bodies and stored data."),
  archived: z.enum(["exclude", "include", "only"]).default("exclude"),
  expand: z.union([
    z.strictObject({
      edgeTypes: z.array(typeRef).min(1).max(16).describe("Edge type names or IDs to follow from each matched node."),
      direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
      depth: z.number().int().min(1).max(3).default(1),
      maxNodes: z.number().int().min(1).max(500).default(100).describe("Node budget per matched node, including it."),
    }),
    z.strictObject({
      knowledgeGraphId: z.string().min(1).max(200).describe("A saved KnowledgeGraph node in this Wiki: expand each matched node with its view."),
      maxNodes: z.number().int().min(1).max(500).optional().describe("Lower the saved view's node budget."),
    }),
    savedSelection,
  ]).optional().describe("Node queries only: follow edges with the shared knowledge-graph traversal, by edge types, a saved KnowledgeGraph, or an inline selection in the shape a KnowledgeGraph saves. Archived and retired records are not traversed."),
  fields: z.union([z.enum(["compact", "full"]), z.array(fieldName).min(1).max(32)]).default("compact")
    .describe("compact (default): IDs, type, title, summary, revision, validity, updatedAt. full: stored records. A list picks attributes; IDs, type IDs, endpoints and revisions are always kept, and retired records carry retired: true."),
  aggregate: z.literal("type").optional().describe("Return counts grouped by entity kind and type instead of records."),
  limit: z.number().int().min(1).max(500).default(100).describe("Most matched records in one page; maxBytes may stop the page sooner."),
  cursor: z.string().min(1).max(512).optional().describe("Continue this query from a previous result's cursor. Keep every other field identical and select only that Wiki (installationIds)."),
}).superRefine((query, context) => {
  if (query.entity === "all" && !query.aggregate) context.addIssue({ code: "custom", path: ["entity"], message: "entity \"all\" requires aggregate" });
  if (query.touching && query.entity !== "edge") context.addIssue({ code: "custom", path: ["touching"], message: "Only edge queries filter by touching nodes" });
  for (const [field, message] of nodeOnlyFilters(query)) context.addIssue({ code: "custom", path: [field], message });
  if (query.expand && query.entity !== "node") context.addIssue({ code: "custom", path: ["expand"], message: "Only node queries expand" });
  if (query.aggregate && (query.expand || query.cursor)) context.addIssue({ code: "custom", path: ["aggregate"], message: "Aggregates take no expand or cursor" });
});
export type GraphQuery = z.infer<typeof graphQuery>;

export const graphQueryInput = z.strictObject({
  queries: z.array(graphQuery).min(1).max(12)
    .refine(queries => new Set(queries.map(query => query.name)).size === queries.length, "Query names must be unique").describe("1-12 named queries, answered together."),
  includeTypes: z.enum(["used", "none"]).default("used").describe("used (default): a compact signature of every type the returned records use."),
  maxBytes: z.number().int().min(8 * 1024).max(256 * 1024).default(64 * 1024).describe("Response budget for this Wiki. Records are never cut; unfinished queries return a cursor."),
});
export type GraphQueryInput = z.input<typeof graphQueryInput>;

const row = z.record(z.string(), z.json());
const count = z.strictObject({ entity: z.enum(kinds), typeId: z.string().nullable(), typeName: z.string().nullable(), count: z.number().int().nonnegative() });
export const graphQueryResult = z.strictObject({
  version: z.literal(1),
  installationId: z.string(),
  /** Deduplicated across queries. */
  nodes: z.array(row), edges: z.array(row), types: z.array(row),
  queries: z.record(z.string(), z.strictObject({
    entity: z.enum([...kinds, "all"]),
    /** Every record matching the filters, across all pages. */
    total: z.number().int().nonnegative(),
    /** Records matched in this page, in ID order. */
    matches: z.array(z.string()),
    /** Records reached beyond the matches: edge endpoints and expansion. */
    related: z.array(z.string()),
    omitted: z.array(z.string()), unresolved: z.array(z.string()),
    missingTypes: z.array(z.string()),
    counts: z.array(count).optional(),
    /** True when this page holds the last match and expansion hit no bound. */
    complete: z.boolean(),
    cursor: z.string().nullable(),
  })),
  /** True when every query is complete. */
  complete: z.boolean(),
});
export type GraphQueryResult = z.infer<typeof graphQueryResult>;

type Row = Record<string, unknown> & { id: string; revision: number };
type Snapshot = Pick<WikiGraphSnapshot, "installationId" | "types" | "nodes" | "edges">;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const hash = async (value: unknown) => (await sha256Hex(canonicalActionValue(value))).slice(0, 24);

const always: Record<Kind, string[]> = { node: ["id", "typeId", "revision"], edge: ["id", "typeId", "fromId", "toId", "revision"], type: ["id", "name", "category", "revision"] };
const compactFields: Record<Kind, string[]> = {
  node: ["title", "summary", "validity", "archived", "updatedAt"],
  edge: ["title", "validity", "archived", "updatedAt"],
  type: ["title", "archived", "updatedAt"],
};
/** Keep only meaningful values: compact output drops empty strings, false and null. */
const present = (value: unknown) => value !== undefined && value !== null && value !== "" && value !== false;
function project(kind: Kind, record: Row, fields: GraphQuery["fields"]) {
  if (fields === "full") return record;
  const picked = [...always[kind], ...(fields === "compact" ? compactFields[kind] : fields)];
  const projected = Object.fromEntries(picked.filter(field => Object.hasOwn(record, field) && (always[kind].includes(field) || present(record[field]))).map(field => [field, record[field]]));
  // Retirement can live in the body, which projections usually leave out: say so.
  return kind !== "type" && isRetired(record as { body?: unknown }) ? { ...projected, retired: true } : projected;
}

/** Category, contract and hashes: enough to tell a documentation change from an ontology change. */
async function typeSignature(type: Row) {
  const contract = { category: type.category, name: type.name, ontology: type.ontology ?? null, properties: type.properties ?? [], jsonSchema: type.jsonSchema ?? null };
  return {
    ...project("type", type, "compact"),
    ...(type.ontology ? { ontology: type.ontology } : {}),
    properties: type.properties ?? [],
    contractHash: await hash(contract),
    bodySchemaHash: type.jsonSchema ? await hash(type.jsonSchema) : null,
    docHash: await hash({ title: type.title ?? "", body: type.body ?? "" }),
  };
}

const searchable: Record<Kind, string[]> = {
  node: ["id", "title", "slug", "summary", "body", "properties", "website"],
  edge: ["id", "title", "body", "properties", "typeId", "fromId", "toId"],
  type: ["id", "name", "title", "body", "properties", "jsonSchema", "ontology", "category"],
};
export function textMatch(kind: Kind, record: Row, needle: string) {
  return searchable[kind].some(field => {
    const value = record[field];
    if (value === undefined || value === null) return false;
    return (typeof value === "string" ? value : JSON.stringify(value)).toLowerCase().includes(needle);
  });
}

type Cursor = { after: string; key: string };
/** Cursors resume only the same filters on the same Wiki. */
async function queryKey(query: GraphQuery, installationId: string) {
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  return hash({ installationId, filters });
}
function readCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/")));
    if (typeof parsed?.after === "string" && typeof parsed?.key === "string") return parsed;
  } catch { /* refused below */ }
  throw new Response("Invalid cursor", { status: 400 });
}
const writeCursor = (cursor: Cursor) => btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

type Addition = { kind: Kind; record: Record<string, unknown> };
/** Platform dispatch reads at most 512 KiB of an app response. */
const hardLimit = 448 * 1024;
/** Each expansion walks the whole graph in memory; bound it per request. */
const maxExpandedRoots = 100;

function indexSnapshot(snapshot: Snapshot) {
  const sorted = (list: unknown[]) => [...list as Row[]].sort((a, b) => compare(a.id, b.id));
  const rows: Record<Kind, Row[]> = { node: sorted(snapshot.nodes), edge: sorted(snapshot.edges), type: sorted(snapshot.types) };
  const map = (list: Row[]) => new Map(list.map(row => [row.id, row]));
  const byId = { node: map(rows.node), edge: map(rows.edge), type: map(rows.type) };
  /** Type names or IDs, resolved against this Wiki; unknown names are reported, not fatal. */
  const typeIds = (refs: string[], category?: "node" | "edge") => {
    const ids = new Set<string>();
    const missing: string[] = [];
    for (const ref of refs) {
      const found = rows.type.filter(type => (type.id === ref || type.name === ref) && (!category || type.category === category));
      for (const type of found) ids.add(type.id);
      if (!found.length) missing.push(ref);
    }
    return { ids, missing };
  };
  // Traversal needs only identity, endpoints and state. Slim records once, so
  // per-root selection doesn't re-read bodies to decide retirement.
  let selectable: SelectableGraph | undefined;
  const slim = (row: Row) => ({ id: row.id, revision: row.revision, typeId: String(row.typeId), fromId: String(row.fromId ?? ""), toId: String(row.toId ?? ""),
    title: String(row.title ?? ""), archived: !!row.archived, ...(isRetired(row as { body?: unknown }) ? { properties: { status: "retired" } } : {}) });
  const records = () => {
    selectable ??= wikiGraphRecords({ installationId: snapshot.installationId, types: snapshot.types, nodes: rows.node.map(slim), edges: rows.edge.map(slim) }, true);
    return selectable;
  };
  return { rows, byId, typeIds, records };
}
type Index = ReturnType<typeof indexSnapshot>;

function matcher(index: Index, query: GraphQuery, missingTypes: Set<string>) {
  const category = query.entity === "node" || query.entity === "edge" ? query.entity : undefined;
  const typeFilter = query.types ? index.typeIds(query.types, category) : null;
  for (const name of typeFilter?.missing ?? []) missingTypes.add(name);
  const ids = query.ids ? new Set(query.ids) : null;
  const slugs = query.slugs ? new Set(query.slugs) : null;
  const sources = query.sources ? new Set(query.sources.map(sourceKey)) : null;
  const touching = query.touching ? new Set(query.touching.nodeIds) : null;
  const direction = query.touching?.direction;
  const touches = (record: Row) => !touching
    || (direction !== "incoming" && touching.has(String(record.fromId))) || (direction !== "outgoing" && touching.has(String(record.toId)));
  const needle = query.text?.toLowerCase();
  const archivedOk = (archived: boolean) => query.archived === "include" || archived === (query.archived === "only");
  return (kind: Kind) => index.rows[kind].filter(record =>
    archivedOk(!!record.archived) && (!ids || ids.has(record.id)) && (!slugs || slugs.has(String(record.slug))) && touches(record)
    && (!typeFilter || typeFilter.ids.has(kind === "type" ? record.id : String(record.typeId)))
    && (!needle || textMatch(kind, record, needle))
    && (kind !== "node" || matchesSourceAndProperties(record, sources, query.properties)));
}

function countGroups(index: Index, scopes: Kind[], matching: (kind: Kind) => Row[]) {
  const counts = new Map<string, z.infer<typeof count>>();
  for (const kind of scopes) for (const record of matching(kind)) {
    // Types group by category; nodes and edges by their type.
    const typeId = kind === "type" ? null : String(record.typeId);
    const group = `${kind}:${typeId ?? String(record.category)}`;
    const typeName = kind === "type" ? String(record.category) : (index.byId.type.get(String(typeId))?.name as string | undefined) ?? null;
    const entry = counts.get(group) ?? { entity: kind, typeId, typeName, count: 0 };
    entry.count++;
    counts.set(group, entry);
  }
  return [...counts.values()].sort((a, b) => compare(a.entity, b.entity) || compare(a.typeName ?? "", b.typeName ?? ""));
}

type Plan = Omit<SavedSelection, "rootTypes"> & { rootTypes?: string[] };
/** Resolves a saved KnowledgeGraph node to its selection; throws a Response when it can't. */
export type KnowledgeGraphResolver = (id: string) => GraphSelectionDefinition;

/** How a query expands each match: edge types, a saved KnowledgeGraph or an inline selection. */
function expansionPlan(index: Index, expand: NonNullable<GraphQuery["expand"]>, missingTypes: Set<string>, resolve?: KnowledgeGraphResolver): Plan | null {
  if ("knowledgeGraphId" in expand) {
    if (!resolve) throw new Response("Saved knowledge graphs are not available here", { status: 400 });
    const saved = resolve(expand.knowledgeGraphId);
    return { ...saved, maxNodes: Math.min(saved.maxNodes, expand.maxNodes ?? saved.maxNodes) };
  }
  if ("relationships" in expand) return expand;
  const edges = index.typeIds(expand.edgeTypes, "edge");
  for (const name of edges.missing) missingTypes.add(name);
  // Archived edge types are not traversed; say so rather than skip silently.
  const usable = [...edges.ids].filter(id => {
    const type = index.byId.type.get(id);
    if (type?.archived) missingTypes.add(`${String(type.name)} (archived)`);
    return !type?.archived;
  });
  const directions = expand.direction === "both" ? (["outgoing", "incoming"] as const) : [expand.direction];
  const relationships = usable.flatMap(type => directions.map(direction => ({ type, direction })));
  return relationships.length ? { relationships, maxDepth: expand.depth, maxNodes: expand.maxNodes, terminalTypes: [], stopAtTypes: [], stopAfterTypes: [] } : null;
}

/** One matched record plus what it brings: edge endpoints, or a bounded expansion. */
function withRelated(index: Index, query: GraphQuery, kind: Kind, record: Row, plan: Plan | null) {
  const additions: Addition[] = [{ kind, record: project(kind, record, query.fields) }];
  const add = (as: "node" | "edge", id: string) => {
    const source = index.byId[as].get(id);
    if (source) additions.push({ kind: as, record: project(as, source, query.fields) });
  };
  if (kind === "edge") for (const end of [record.fromId, record.toId]) add("node", String(end));
  // A root whose type is archived or missing has nothing to traverse from.
  const rootType = index.byId.type.get(String(record.typeId));
  if (!plan || !rootType || rootType.archived) return { additions, omitted: [], unresolved: [], bounded: false };
  let selection: ReturnType<typeof selectGraph>;
  try {
    selection = selectGraph(index.records(), [record.id], { id: `query:${query.name}`, version: 1, purpose: "", ...plan, rootTypes: plan.rootTypes ?? [String(record.typeId)] });
  } catch (error) {
    throw new Response(`Query ${query.name}: ${error instanceof Error ? error.message : "the expansion is invalid"}`, { status: 400 });
  }
  for (const node of selection.nodes) if (node.ref.id !== record.id) add("node", node.ref.id);
  for (const edge of selection.edges) add("edge", edge.ref.id);
  return { additions, omitted: selection.omitted.map(ref => ref.id), unresolved: selection.unresolved.map(ref => ref.id), bounded: selection.incomplete };
}

/** The deduplicated response being filled, within the byte budget. */
function responseBuffer(index: Index, input: z.infer<typeof graphQueryInput>) {
  const store: Record<Kind, Map<string, Record<string, unknown>>> = { node: new Map(), edge: new Map(), type: new Map() };
  const signatures = new Map<string, Record<string, unknown>>();
  let spent = 512; // Envelope; each query adds its summary.
  let admitted = false;
  let expanded = 0;
  const newRecord = ({ kind, record }: Addition) => {
    const existing = store[kind].get(String(record.id));
    return !existing || Object.keys(record).some(key => !Object.hasOwn(existing, key));
  };
  async function typeAdditions(additions: Addition[]) {
    if (input.includeTypes !== "used") return [];
    const ids = new Set(additions.map(({ kind, record }) => String(kind === "type" ? record.id : record.typeId)));
    const found: Addition[] = [];
    for (const id of ids) {
      const type = index.byId.type.get(id);
      if (!type || (store.type.has(id) && signatures.has(id))) continue;
      const signature = signatures.get(id) ?? await typeSignature(type);
      signatures.set(id, signature);
      found.push({ kind: "type", record: signature });
    }
    return found;
  }
  return {
    /** Whether another matched root may expand in this request (CPU bound). */
    expand() { return expanded++ < maxExpandedRoots; },
    /** Add records and the type signatures they introduce, only if all fit.
     * The first admission is allowed past maxBytes (up to the hard ceiling)
     * so every response makes progress. `ids` counts reported omitted IDs. */
    async admit(records: Addition[], ids = 0) {
      const additions = [...records, ...await typeAdditions(records)];
      const fresh = additions.filter(newRecord);
      // Records plus their IDs in the query's matches/related/omitted lists.
      const size = bytes(fresh.map(item => item.record)) + 40 * (additions.length + ids);
      if (admitted && spent + size > input.maxBytes) return false;
      if (spent + size > hardLimit)
        throw new Response("One matched record with its expansion is larger than the response limit; lower expand.maxNodes or use compact fields", { status: 413 });
      spent += size;
      admitted = true;
      for (const { kind, record } of fresh) store[kind].set(String(record.id), { ...store[kind].get(String(record.id)), ...record });
      return true;
    },
    spend(size: number) { spent += size; },
    sorted(kind: Kind) { return [...store[kind].values()].sort((a, b) => compare(String(a.id), String(b.id))) as GraphQueryResult["nodes"]; },
  };
}
type Buffer = ReturnType<typeof responseBuffer>;

const collect = (into: Set<string>, ids: string[]) => { for (const id of ids) into.add(id); };

async function pageQuery(index: Index, buffer: Buffer, query: GraphQuery, key: string, cursor: Cursor | null, missingTypes: Set<string>, stopped: boolean, resolve?: KnowledgeGraphResolver) {
  const kind = query.entity as Kind;
  const all = matcher(index, query, missingTypes)(kind);
  const remaining = cursor ? all.filter(record => record.id > cursor.after) : all;
  const plan = query.expand ? expansionPlan(index, query.expand, missingTypes, resolve) : null;
  const matches: string[] = [];
  const related = new Set<string>();
  const omitted = new Set<string>();
  const unresolved = new Set<string>();
  let bounded = false;
  let exhausted = stopped;
  for (const record of stopped ? [] : remaining.slice(0, query.limit)) {
    if (plan && !buffer.expand()) { exhausted = true; break; }
    const found = withRelated(index, query, kind, record, plan);
    if (!await buffer.admit(found.additions, found.omitted.length + found.unresolved.length)) { exhausted = true; break; }
    matches.push(record.id);
    collect(related, found.additions.slice(1).map(({ record: added }) => String(added.id)));
    collect(omitted, found.omitted);
    collect(unresolved, found.unresolved);
    bounded ||= found.bounded;
  }
  const done = matches.length === remaining.length;
  const matched = new Set(matches);
  const summary: GraphQueryResult["queries"][string] = {
    entity: query.entity, total: all.length, matches,
    related: [...related].filter(id => !matched.has(id)).sort(compare),
    omitted: [...omitted].sort(compare), unresolved: [...unresolved].sort(compare), missingTypes: [...missingTypes],
    complete: done && !bounded && !omitted.size,
    cursor: done ? null : writeCursor({ after: matches.at(-1) ?? cursor?.after ?? "", key }),
  };
  buffer.spend(300);
  return { summary, exhausted };
}

/** Run a batch of named queries over one Wiki snapshot within a byte budget. */
export async function queryGraph(snapshot: Snapshot, raw: GraphQueryInput, { knowledgeGraph }: { knowledgeGraph?: KnowledgeGraphResolver } = {}): Promise<GraphQueryResult> {
  const input = graphQueryInput.parse(raw);
  const index = indexSnapshot(snapshot);
  const buffer = responseBuffer(index, input);
  const queries: GraphQueryResult["queries"] = {};
  // Once the budget runs out, later queries keep their place with a cursor.
  let exhausted = false;
  for (const query of input.queries) {
    const key = await queryKey(query, snapshot.installationId);
    const cursor = query.cursor ? readCursor(query.cursor) : null;
    if (cursor && cursor.key !== key) throw new Response(`Cursor for query ${query.name} belongs to different filters or another Wiki; continue with installationIds set to that Wiki`, { status: 400 });
    const missingTypes = new Set<string>();
    if (query.aggregate) {
      const matching = matcher(index, query, missingTypes);
      const counts = countGroups(index, query.entity === "all" ? [...kinds] : [query.entity], matching);
      queries[query.name] = { entity: query.entity, total: counts.reduce((sum, row) => sum + row.count, 0), matches: [], related: [], omitted: [], unresolved: [], missingTypes: [...missingTypes], counts, complete: true, cursor: null };
      buffer.spend(300 + bytes(counts));
      continue;
    }
    const page = await pageQuery(index, buffer, query, key, cursor, missingTypes, exhausted, knowledgeGraph);
    queries[query.name] = page.summary;
    exhausted = page.exhausted;
  }
  return {
    version: 1, installationId: snapshot.installationId,
    nodes: buffer.sorted("node"), edges: buffer.sorted("edge"), types: buffer.sorted("type"),
    queries, complete: Object.values(queries).every(query => query.complete),
  };
}

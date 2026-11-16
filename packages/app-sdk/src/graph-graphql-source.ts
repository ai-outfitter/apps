// Where generated GraphQL resolvers read records: a GraphSource over the same
// rows graph.query returns in fields:"full", loaded through a per-request batch
// loader so each (type, field) costs one source call per level, never one per record.
// Collections and relationships read ordered, bounded pages (`nodePage`, `relationPage`):
// a database source runs them as SQL, memorySource emulates them over a snapshot.
import { edgeFilterFields, matchesFilter, nodeFilterFields, type RecordFilter } from "./graph-filter";
import type { TypeRow } from "./graph-graphql-names";
import { type OrderName, orders } from "./graph-order";
import { textMatch } from "./graph-query";
import { isRetired } from "./knowledge-graph";
import type { WikiGraphSnapshot } from "./graph-contracts/index";

export type ArchivedFilter = "exclude" | "include" | "only";
export type GraphRow = Record<string, unknown> & { id: string; typeId: string; revision: number };
export type EdgeRow = GraphRow & { fromId: string; toId: string };
export type SourceRef = { installationId: string; type: string; id: string };
export type PropertyFilter = Record<string, string | number | boolean>;
/** A lookup of known records. `slugs` are exact node slugs: a Wiki's addresses, unique across its node types (edges have none). */
export type NodeQuery = { typeIds?: string[]; ids?: string[]; slugs?: string[]; archived?: ArchivedFilter; text?: string;
  /** Pages whose canonical `source` is one of these records. */
  sources?: SourceRef[];
  /** Stored property values that must match exactly. */
  properties?: PropertyFilter };
export const sourceKey = (ref: SourceRef) => `${ref.installationId}/${ref.type}/${ref.id}`;
/** Whether a row's `source` names one of `refs`, and its properties hold every value in `wanted`. */
export function matchesSourceAndProperties(row: Record<string, unknown>, sources: ReadonlySet<string> | null, wanted?: PropertyFilter) {
  if (sources) {
    const source = row.source as SourceRef | null | undefined;
    if (!source || typeof source !== "object" || !sources.has(sourceKey(source))) return false;
  }
  if (wanted) {
    const properties = (row.properties ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(wanted)) if (properties[key] !== value) return false;
  }
  return true;
}
/** An edge matches fromIds or toIds (callers here pass one of them per call). */
export type EdgeQuery = { typeIds?: string[]; ids?: string[]; fromIds?: string[]; toIds?: string[]; archived?: ArchivedFilter };

/** What a page is ordered by: a record column (epoch ms for the timestamps), then the ID in the same direction. */
export type OrderField = "id" | "createdAt" | "updatedAt" | "title";
export type Order = { field: OrderField; descending: boolean };
/** Where a page resumes: after the record with this order value and ID. */
export type Keyset = { value: string | number | null; id: string };
/** At most `first + 1` records after `after` in the order `orderBy` names (`orders[orderBy]`), so the caller can tell whether more follow. */
export type Page = { orderBy: OrderName; first: number; after: Keyset | null };
/** A collection's records: of these types (left out: of every node type), optionally of these IDs, matching `text` (a case-insensitive
 * literal substring of the ID, title, slug, summary, body, website or stored properties), visible under
 * `archived` (no retired rule, as graph.query matches), valid at `at` and passing `filter` (nodeFilterFields). */
export type NodeFilter = { typeIds?: string[]; ids?: string[]; text?: string; archived?: ArchivedFilter; at?: string; filter?: RecordFilter };
export type NodePageQuery = NodeFilter & Page;
export type RelationDirection = "outgoing" | "incoming" | "both";
/** What a relationship reaches from each parent: edges of `edgeTypeIds` in `direction` whose other end is a
 * node of `targetTypeIds`, both visible under `archived` (EXCLUDE also hides retired records; ONLY asks for
 * archived edges, whatever their far end) and valid at `at`. `rows: "node"` lists each far node once
 * (through its lowest edge ID), ordered by the node; `rows: "edge"` lists each edge, ordered by the edge.
 * `filter` keeps the rows whose listed record (the far node, or the edge) passes it.
 * With `through`, the relationship is two hops (a projection): each parent reaches nodes of `through.nodeTypeIds`
 * over edges of `through.edgeTypeIds` in either direction, and from those the far nodes over `edgeTypeIds`;
 * every edge and node on the way is visible and valid as above, and a parent never lists itself. */
export type RelationFilter = { parentIds: string[]; edgeTypeIds: string[]; direction: RelationDirection; targetTypeIds: string[];
  archived?: ArchivedFilter; at?: string; rows: "node" | "edge"; filter?: RecordFilter;
  through?: { edgeTypeIds: string[]; nodeTypeIds: string[] } };
/** A page per parent: at most `first + 1` rows for each of `parentIds`. */
export type RelationPageQuery = RelationFilter & Page;
export type RelationRow = { parentId: string; edge: EdgeRow; node: GraphRow };
/** A collection that can match nothing, so no source is asked for it. */
export const emptyCollection = (filter: NodeFilter) => filter.typeIds?.length === 0 || filter.ids?.length === 0;
/** A relationship that can reach nothing, so no source is asked for it. */
export const emptyRelation = (filter: Omit<RelationFilter, "parentIds"> & { parentIds?: string[] }) => !filter.edgeTypeIds.length || !filter.targetTypeIds.length
  || filter.parentIds?.length === 0 || (!!filter.through && (!filter.through.edgeTypeIds.length || !filter.through.nodeTypeIds.length));
export interface GraphSource {
  /** The type rows to build the schema from. executeGraphQuery takes them as `types`
   * instead, so a caller can read them once and cache the schema. */
  types(): Promise<TypeRow[]>;
  nodes(query: NodeQuery): Promise<GraphRow[]>;
  edges(query: EdgeQuery): Promise<EdgeRow[]>;
  /** One ordered page of a collection, read bounded where the records live. */
  nodePage(query: NodePageQuery): Promise<GraphRow[]>;
  nodeCount(query: NodeFilter): Promise<number>;
  /** One ordered page of a relationship for every parent at once, each parent's rows in page order. */
  relationPage(query: RelationPageQuery): Promise<RelationRow[]>;
  /** How many rows each parent's relationship holds (a parent with none may be left out). */
  relationCount(query: RelationFilter): Promise<Map<string, number>>;
  /** For a source keyed by more than the ID (a schema composed over several graphs): the key a row's slug is
   * also found under, so a lookup of that key (one graph's slug) answers only that graph's row. */
  slugKey?(row: GraphRow): string;
}

/** Never leave the Wiki, whatever a source hands over. */
const hiddenKeys = ["externalKey"];
export const publicRow = <T extends Record<string, unknown>>(row: T): T =>
  hiddenKeys.some(key => Object.hasOwn(row, key)) ? Object.fromEntries(Object.entries(row).filter(([key]) => !hiddenKeys.includes(key))) as T : row;
/** Code-unit order, as graph.query sorts IDs. */
export const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** graph.query's archived filter; `traversal` also hides retired records under EXCLUDE, as its traversal does. */
export function visible(row: Record<string, unknown>, archived: ArchivedFilter = "exclude", traversal = true) {
  if (archived === "include") return true;
  if (archived === "only") return !!row.archived;
  return !row.archived && !(traversal && isRetired(row as { body?: unknown; properties?: unknown }));
}
const setOf = (list: string[] | undefined) => (list ? new Set(list) : null);
/** The rows under each key, in the order given. */
export function groupBy<T>(rows: T[], keyOf: (row: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row), list = grouped.get(key);
    if (list) list.push(row); else grouped.set(key, [row]);
  }
  return grouped;
}

const field = (row: GraphRow, key: string) => (row.properties as Record<string, unknown> | null | undefined)?.[key];
/** Validity columns win; otherwise the conventional property names. */
export function validFrom(row: GraphRow) {
  const validity = row.validity as { from?: string | null } | null | undefined;
  return validity?.from ?? field(row, "valid_from") ?? field(row, "validFrom") ?? null;
}
export function validUntil(row: GraphRow) {
  const validity = row.validity as { to?: string | null } | null | undefined;
  return validity?.to ?? field(row, "valid_until") ?? field(row, "validUntil") ?? field(row, "valid_to") ?? null;
}
export function validAt(row: GraphRow, at: string | undefined) {
  if (!at) return true;
  const time = Date.parse(at), from = validFrom(row), until = validUntil(row);
  return (from == null || Date.parse(String(from)) <= time) && (until == null || time < Date.parse(String(until)));
}

/** A row's key under `order`: the column's value (null when it holds no string or number) and the ID. */
export function keyOf(row: GraphRow, { field: column }: Order): Keyset {
  const value = row[column];
  return { value: typeof value === "string" || typeof value === "number" ? value : null, id: row.id };
}
/** SQLite's order: null, then numbers, then strings by code unit; ties by ID. */
const kind = (value: Keyset["value"]) => (value === null ? 0 : typeof value === "number" ? 1 : 2);
function compareKeys(a: Keyset, b: Keyset) {
  const byKind = kind(a.value) - kind(b.value);
  if (byKind) return byKind;
  const byValue = a.value === b.value || a.value === null ? 0
    : typeof a.value === "number" ? Math.sign(a.value - (b.value as number)) : compareIds(a.value, b.value as string);
  return byValue || compareIds(a.id, b.id);
}
/** In memory, what a database source reads with ORDER BY and LIMIT: the first `first + 1` rows after `after`. */
export function pageRows<T>(rows: T[], key: (row: T) => Keyset, { orderBy, first, after }: Page) {
  const sign = orders[orderBy].descending ? -1 : 1;
  const keyed = rows.map(row => ({ row, key: key(row) })).sort((a, b) => sign * compareKeys(a.key, b.key));
  return (after ? keyed.filter(item => sign * compareKeys(item.key, after) > 0) : keyed).slice(0, first + 1).map(item => item.row);
}

/** A GraphSource over a snapshot Wiki already read (graph.read records). */
export function memorySource(snapshot: Pick<WikiGraphSnapshot, "installationId" | "types" | "nodes" | "edges">): GraphSource {
  const sorted = <T extends { id: string }>(rows: T[]) => rows.map(publicRow).sort((a, b) => compareIds(a.id, b.id));
  const nodes = sorted(snapshot.nodes as GraphRow[]);
  const edges = sorted(snapshot.edges as EdgeRow[]);
  const byId = new Map(nodes.map(row => [row.id, row]));
  const outgoing = groupBy(edges, row => row.fromId), incoming = groupBy(edges, row => row.toId);
  const read: GraphSource["nodes"] = async query => {
    const needle = query.text?.toLowerCase();
    const types = setOf(query.typeIds), ids = setOf(query.ids), slugs = setOf(query.slugs);
    const sources = query.sources ? new Set(query.sources.map(sourceKey)) : null;
    return nodes.filter(row => visible(row, query.archived, false) && (!types || types.has(row.typeId)) && (!ids || ids.has(row.id))
      && (!slugs || slugs.has(String(row.slug))) && (!needle || textMatch("node", row, needle)) && matchesSourceAndProperties(row, sources, query.properties));
  };
  const collection = async ({ at, filter, ...query }: NodeFilter) => (await read(query)).filter(row => validAt(row, at) && matchesFilter(row, filter, nodeFilterFields));
  /** Each parent's rows in edge ID order; `rows: "node"` keeps each far node once. */
  const relations = ({ parentIds, edgeTypeIds, direction, targetTypeIds, archived, at, rows, filter, through }: RelationFilter) => {
    /** One hop from a node: its edges of `types` with the node of `targets` at the other end, both visible and valid. */
    const hop = (nodeId: string, types: Set<string>, way: RelationDirection, targets: Set<string>) => [
      ...(way === "incoming" ? [] : outgoing.get(nodeId) ?? []).map(edge => ({ edge, otherId: edge.toId })),
      ...(way === "outgoing" ? [] : incoming.get(nodeId) ?? []).map(edge => ({ edge, otherId: edge.fromId })),
    ].flatMap(({ edge, otherId }) => {
      if (!types.has(edge.typeId) || !visible(edge, archived) || !validAt(edge, at)) return [];
      const node = byId.get(otherId);
      // ONLY asks for archived edges; their endpoints may be active.
      return !node || !targets.has(node.typeId) || !(archived === "only" || visible(node, archived)) || !validAt(node, at) ? [] : [{ edge, node }];
    });
    const types = new Set(edgeTypeIds), targets = new Set(targetTypeIds);
    /** Whether the filter keeps the record the page lists: the far node, or the edge. */
    const listed = ({ edge, node }: { edge: EdgeRow; node: GraphRow }) => (rows === "node" ? matchesFilter(node, filter, nodeFilterFields) : matchesFilter(edge, filter, edgeFilterFields));
    const first = through && { types: new Set(through.edgeTypeIds), targets: new Set(through.nodeTypeIds) };
    return [...new Set(parentIds)].map(parentId => {
      const seen = new Set<string>();
      const starts = first ? [...new Set(hop(parentId, first.types, "both", first.targets).map(({ node }) => node.id))] : [parentId];
      const found = starts.flatMap(start => hop(start, types, direction, targets)).filter(({ node }) => !first || node.id !== parentId)
        .filter(listed).sort((a, b) => compareIds(a.edge.id, b.edge.id));
      return found.flatMap(({ edge, node }): RelationRow[] => {
        const key = rows === "node" ? node.id : edge.id;
        return seen.has(key) || !seen.add(key) ? [] : [{ parentId, edge, node }];
      });
    });
  };
  return {
    types: async () => sorted(snapshot.types as TypeRow[]),
    nodes: read,
    edges: async query => {
      const types = setOf(query.typeIds), ids = setOf(query.ids), from = setOf(query.fromIds), to = setOf(query.toIds);
      return edges.filter(row => visible(row, query.archived, false) && (!types || types.has(row.typeId)) && (!ids || ids.has(row.id))
        && (!(from || to) || !!from?.has(row.fromId) || !!to?.has(row.toId)));
    },
    nodePage: async query => pageRows(await collection(query), row => keyOf(row, orders[query.orderBy]), query),
    nodeCount: async query => (await collection(query)).length,
    relationPage: async query => relations(query).flatMap(list => pageRows(list, row => keyOf(query.rows === "node" ? row.node : row.edge, orders[query.orderBy]), query)),
    relationCount: async query => new Map(relations(query).flatMap(list => (list.length ? [[list[0].parentId, list.length] as const] : []))),
  };
}

const later = (run: () => void) => (typeof setImmediate === "function" ? setImmediate(run) : setTimeout(run, 0));

/** Collects keys asked for in one tick and answers them with one call. */
function batch<V>(run: (keys: string[]) => Promise<Map<string, V>>, missing: V) {
  const cache = new Map<string, Promise<V>>();
  let pending: Map<string, { resolve: (value: V) => void; reject: (error: unknown) => void }> | null = null;
  const flush = async () => {
    const waiting = pending as NonNullable<typeof pending>;
    pending = null;
    try {
      const found = await run([...waiting.keys()]);
      for (const [key, { resolve }] of waiting) resolve(found.get(key) ?? missing);
    } catch (error) {
      for (const [key, { reject }] of waiting) { cache.delete(key); reject(error); }
    }
  };
  return {
    load(key: string) {
      const cached = cache.get(key);
      if (cached) return cached;
      const promise = new Promise<V>((resolve, reject) => {
        if (!pending) { pending = new Map(); later(() => void flush()); }
        pending.set(key, { resolve, reject });
      });
      cache.set(key, promise);
      return promise;
    },
    prime(key: string, value: V) { if (!cache.has(key)) cache.set(key, Promise.resolve(value)); },
  };
}

/** One call answers every node asked for edges of these types in this direction. */
function edgeBatch(source: GraphSource, typeIds: string[] | null, direction: "outgoing" | "incoming") {
  const end = direction === "outgoing" ? "fromId" : "toId";
  return batch<EdgeRow[]>(async ids => {
    const rows = await source.edges({ ...(typeIds ? { typeIds } : {}), [direction === "outgoing" ? "fromIds" : "toIds"]: ids, archived: "include" });
    return groupBy(rows.map(publicRow), row => row[end]);
  }, []);
}

export type RelationAsk = Omit<RelationPageQuery, "parentIds">;
export type RelationCountAsk = Omit<RelationFilter, "parentIds">;

/** Per-request loader: nodes by ID or slug, edges touching a node by (types, direction), and relationship
 * pages and counts by (query, parent): each kind asked for in one tick is one source call. */
export function graphLoader(source: GraphSource) {
  const nodes = batch<GraphRow | undefined>(async ids => new Map((await source.nodes({ ids, archived: "include" })).map(row => [row.id, publicRow(row)])), undefined);
  const prime = (rows: GraphRow[]) => { for (const row of rows) nodes.prime(row.id, row); return rows; };
  // A slug names one node in a Wiki; a source over several graphs may answer one row per graph, each also under its slugKey.
  const slugs = batch<GraphRow[]>(async wanted => {
    const rows = prime((await source.nodes({ slugs: wanted, archived: "include" })).map(publicRow));
    const keyed = rows.flatMap(row => [...new Set([String(row.slug), ...(source.slugKey ? [source.slugKey(row)] : [])])].map(key => ({ key, row })));
    return new Map([...groupBy(keyed, item => item.key)].map(([key, items]) => [key, items.map(item => item.row)]));
  }, []);
  const touching = new Map<string, ReturnType<typeof edgeBatch>>();
  const pages = new Map<string, ReturnType<typeof batch<RelationRow[]>>>();
  const counts = new Map<string, ReturnType<typeof batch<number>>>();
  /** The batch for one query, made on first use. */
  const keyed = <V>(cache: Map<string, ReturnType<typeof batch<V>>>, key: string, make: () => ReturnType<typeof batch<V>>) => {
    const found = cache.get(key) ?? make();
    cache.set(key, found);
    return found;
  };
  return {
    node: (id: string) => nodes.load(id),
    /** Every node with this slug, or slug key (at most one per graph), remembered for later ID lookups. */
    slug: (slug: string) => slugs.load(slug),
    /** One page of a collection, remembered for later ID lookups. */
    async nodePage(query: NodePageQuery) { return emptyCollection(query) ? [] : prime((await source.nodePage(query)).map(publicRow)); },
    async nodeCount(query: NodeFilter) { return emptyCollection(query) ? 0 : source.nodeCount(query); },
    edges(typeIds: string[] | null, direction: "outgoing" | "incoming", nodeId: string) {
      const loader = keyed(touching, `${direction}:${typeIds?.join(",") ?? "*"}`, () => edgeBatch(source, typeIds, direction));
      return loader.load(nodeId);
    },
    /** One parent's page of a relationship; every parent asked for with the same query shares one source call. */
    async relation(ask: RelationAsk, parentId: string) {
      if (emptyRelation(ask)) return [];
      return keyed(pages, JSON.stringify(ask), () => batch<RelationRow[]>(async parentIds => {
        const rows = (await source.relationPage({ ...ask, parentIds })).map(row => ({ parentId: row.parentId, edge: publicRow(row.edge), node: publicRow(row.node) }));
        prime(rows.map(row => row.node));
        return groupBy(rows, row => row.parentId);
      }, [])).load(parentId);
    },
    async relationCount(ask: RelationCountAsk, parentId: string) {
      if (emptyRelation(ask)) return 0;
      return keyed(counts, JSON.stringify(ask), () => batch<number>(parentIds => source.relationCount({ ...ask, parentIds }), 0)).load(parentId);
    },
  };
}
export type GraphLoader = ReturnType<typeof graphLoader>;

// Where generated GraphQL resolvers read records: a GraphSource over the same
// rows graph.query returns in fields:"full", loaded through a per-request batch
// loader so each (type, field) costs one source call per level, never one per record.
import type { TypeRow } from "./graph-graphql-names";
import { textMatch } from "./graph-query";
import { isRetired } from "./knowledge-graph";
import type { WikiGraphSnapshot } from "@ai-outfitter/onto-contracts";

export type ArchivedFilter = "exclude" | "include" | "only";
export type GraphRow = Record<string, unknown> & { id: string; typeId: string; revision: number };
export type EdgeRow = GraphRow & { fromId: string; toId: string };
/** `slugs` are exact node slugs: a Wiki's addresses, unique across its node types (edges have none). */
export type SourceRef = { installationId: string; type: string; id: string };
export type PropertyFilter = Record<string, string | number | boolean>;
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
export interface GraphSource {
  /** The type rows to build the schema from. executeGraphQuery takes them as `types`
   * instead, so a caller can read them once and cache the schema. */
  types(): Promise<TypeRow[]>;
  nodes(query: NodeQuery): Promise<GraphRow[]>;
  edges(query: EdgeQuery): Promise<EdgeRow[]>;
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

/** A GraphSource over a snapshot Wiki already read (graph.read records). */
export function memorySource(snapshot: Pick<WikiGraphSnapshot, "installationId" | "types" | "nodes" | "edges">): GraphSource {
  const sorted = <T extends { id: string }>(rows: T[]) => rows.map(publicRow).sort((a, b) => compareIds(a.id, b.id));
  const nodes = sorted(snapshot.nodes as GraphRow[]);
  const edges = sorted(snapshot.edges as EdgeRow[]);
  return {
    types: async () => sorted(snapshot.types as TypeRow[]),
    nodes: async query => {
      const needle = query.text?.toLowerCase();
      const types = setOf(query.typeIds), ids = setOf(query.ids), slugs = setOf(query.slugs);
      const sources = query.sources ? new Set(query.sources.map(sourceKey)) : null;
      return nodes.filter(row => visible(row, query.archived, false) && (!types || types.has(row.typeId)) && (!ids || ids.has(row.id))
        && (!slugs || slugs.has(String(row.slug))) && (!needle || textMatch("node", row, needle)) && matchesSourceAndProperties(row, sources, query.properties));
    },
    edges: async query => {
      const types = setOf(query.typeIds), ids = setOf(query.ids), from = setOf(query.fromIds), to = setOf(query.toIds);
      return edges.filter(row => visible(row, query.archived, false) && (!types || types.has(row.typeId)) && (!ids || ids.has(row.id))
        && (!(from || to) || !!from?.has(row.fromId) || !!to?.has(row.toId)));
    },
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
    const grouped = new Map<string, EdgeRow[]>();
    for (const row of rows.map(publicRow)) {
      const list = grouped.get(row[end]);
      if (list) list.push(row); else grouped.set(row[end], [row]);
    }
    return grouped;
  }, []);
}

/** Per-request loader: nodes by ID or slug, edges touching a node by (types, direction). */
export function graphLoader(source: GraphSource) {
  const nodes = batch<GraphRow | undefined>(async ids => new Map((await source.nodes({ ids, archived: "include" })).map(row => [row.id, publicRow(row)])), undefined);
  const prime = (rows: GraphRow[]) => { for (const row of rows) nodes.prime(row.id, row); return rows; };
  // A slug names one node in a Wiki; a source over several graphs may answer one row per graph, each also under its slugKey.
  const slugs = batch<GraphRow[]>(async wanted => {
    const grouped = new Map<string, GraphRow[]>();
    for (const row of prime((await source.nodes({ slugs: wanted, archived: "include" })).map(publicRow))) {
      for (const key of new Set([String(row.slug), ...(source.slugKey ? [source.slugKey(row)] : [])])) {
        const list = grouped.get(key);
        if (list) list.push(row); else grouped.set(key, [row]);
      }
    }
    return grouped;
  }, []);
  const touching = new Map<string, ReturnType<typeof edgeBatch>>();
  return {
    node: (id: string) => nodes.load(id),
    /** Every node with this slug, or slug key (at most one per graph), remembered for later ID lookups. */
    slug: (slug: string) => slugs.load(slug),
    /** Nodes of a query (a collection), remembered for later ID lookups. */
    async nodes(query: NodeQuery) { return prime((await source.nodes(query)).map(publicRow)); },
    edges(typeIds: string[] | null, direction: "outgoing" | "incoming", nodeId: string) {
      const key = `${direction}:${typeIds?.join(",") ?? "*"}`;
      const loader = touching.get(key) ?? edgeBatch(source, typeIds, direction);
      touching.set(key, loader);
      return loader.load(nodeId);
    },
  };
}
export type GraphLoader = ReturnType<typeof graphLoader>;

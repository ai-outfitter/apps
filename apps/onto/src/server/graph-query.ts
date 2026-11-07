import { compareIds, type EdgeRow, type GraphRow, type TypeRow } from "@ai-outfitter/app-sdk/graph-graphql";
import { type GraphQuery, graphQueryInput, type GraphQueryInput, queryGraph, textMatch } from "@ai-outfitter/app-sdk/graph-query";
import { normalizeRule } from "@ai-outfitter/app-sdk/graph-selection";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { wikiGraphRecords } from "@ai-outfitter/app-sdk/wiki";
import { asc } from "drizzle-orm";
import { readType } from "../lib/type-metadata";
import type { Database } from "./graph";
import { databaseSource } from "./graph-source";
import { savedDefinition } from "./knowledge-graph-select";
import { graphTypes } from "./schema";

/** Where a query's cursor resumes, or "" when it has none or it doesn't parse (queryGraph refuses it). */
function cursorAfter(cursor: string | undefined) {
  try { return cursor ? String(JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))).after ?? "") : ""; } catch { return ""; }
}

/** The rows read so far, and reads that add to them through the indexed source. */
function candidates(db: Database, installationId: string, types: TypeRow[]) {
  const source = databaseSource(db);
  const nodes = new Map<string, GraphRow>(), edges = new Map<string, EdgeRow>();
  const keep = <T extends { id: string }>(into: Map<string, T>, rows: T[]) => { for (const row of rows) into.set(row.id, row); return rows; };
  const nodesById = async (ids: string[]) => {
    const wanted = [...new Set(ids)].filter(id => !nodes.has(id));
    if (wanted.length) keep(nodes, await source.nodes({ ids: wanted, archived: "include" }));
  };
  const typeIds = (refs: string[] | undefined, category?: string) =>
    refs && types.filter(type => refs.some(ref => ref === type.id || ref === type.name) && (!category || type.category === category)).map(type => type.id);
  const node = (id: string) => {
    const row = nodes.get(id);
    return row ? wikiGraphRecords({ installationId, types: types as never, nodes: [row as never], edges: [] }, true).nodes[0] ?? null : null;
  };
  /** Edges of `refs` types within `depth + 1` hops of `rootIds`, either direction, and their endpoints. */
  const neighborhood = async (rootIds: string[], refs: string[], depth: number) => {
    const seen = new Set(rootIds), followed = typeIds(refs, "edge");
    for (let hop = 0, frontier = rootIds; hop <= depth && frontier.length; hop++) {
      const found = keep(edges, await source.edges({ typeIds: followed, fromIds: frontier, toIds: frontier, archived: "include" }));
      frontier = [...new Set(found.flatMap(edge => [edge.fromId, edge.toId]))].filter(id => !seen.has(id));
      for (const id of frontier) seen.add(id);
      await nodesById(frontier);
    }
  };
  /** The rules an expansion follows; a KnowledgeGraph that can't be used is refused later by queryGraph. */
  const followed = (expand: NonNullable<GraphQuery["expand"]>) => {
    if ("edgeTypes" in expand) return { refs: expand.edgeTypes, depth: expand.depth };
    if ("relationships" in expand) return { refs: expand.relationships.map(rule => normalizeRule(rule).type), depth: expand.maxDepth };
    try {
      const saved = savedDefinition(node(expand.knowledgeGraphId));
      return { refs: saved.relationships.map(rule => normalizeRule(rule).type), depth: saved.maxDepth };
    } catch { return null; }
  };
  const touchingIds = ({ nodeIds, direction }: NonNullable<GraphQuery["touching"]>) =>
    ({ fromIds: direction === "incoming" ? undefined : nodeIds, toIds: direction === "outgoing" ? undefined : nodeIds });
  const filterOf = (query: GraphQuery) =>
    ({ typeIds: typeIds(query.types, query.entity === "node" || query.entity === "edge" ? query.entity : undefined), ids: query.ids, archived: query.archived });
  const nodeFilter = (query: GraphQuery) => ({ ...filterOf(query), ...(query.slugs ? { slugs: query.slugs } : {}),
    ...(query.sources ? { sources: query.sources } : {}), ...(query.properties ? { properties: query.properties } : {}) });

  /** Every record the query's filters match, its page's edge endpoints and the reach of its expansion. */
  async function read(query: GraphQuery) {
    const filter = filterOf(query), reads = (kind: string) => query.entity === kind || query.entity === "all";
    const after = cursorAfter(query.cursor), needle = query.text?.toLowerCase();
    const page = <T extends { id: string }>(rows: T[]) => query.aggregate ? [] : rows.filter(row => row.id > after).sort((a, b) => compareIds(a.id, b.id)).slice(0, query.limit);
    const roots = reads("node") ? page(keep(nodes, await source.nodes({ ...nodeFilter(query), text: query.text }))) : [];
    const found = reads("edge") ? keep(edges, await source.edges({ ...filter, ...(query.touching && touchingIds(query.touching)) })) : [];
    await nodesById(page(found.filter(edge => !needle || textMatch("edge", edge as never, needle))).flatMap(edge => [edge.fromId, edge.toId]));
    // queryGraph resolves a saved KnowledgeGraph even when nothing matched.
    if (query.expand && "knowledgeGraphId" in query.expand) await nodesById([query.expand.knowledgeGraphId]);
    const reach = query.expand && roots.length ? followed(query.expand) : null;
    // queryGraph expands at most 100 roots in a request; the reach is read once for every query (reachAll).
    return reach ? { rootIds: roots.slice(0, 100).map(row => row.id), ...reach } : null;
  }
  /** The expansions of every query in one pass: one indexed read per hop over all their roots and
   * followed types together, rather than a hop loop per query. A superset is harmless: queryGraph
   * applies each query's own selection over the loaded rows. */
  async function reachAll(plans: ({ rootIds: string[]; refs: string[]; depth: number } | null)[]) {
    const wanted = plans.filter((plan): plan is NonNullable<typeof plan> => !!plan);
    if (!wanted.length) return;
    const rootIds = [...new Set(wanted.flatMap(plan => plan.rootIds))];
    const refs = [...new Set(wanted.flatMap(plan => plan.refs))];
    await neighborhood(rootIds, refs, Math.max(...wanted.map(plan => plan.depth)));
  }
  return { read, reachAll, node, snapshot: () => ({ installationId, types, nodes: [...nodes.values()], edges: [...edges.values()] }) };
}

/** Batched, byte-bounded queries over the same records `graph.read` returns,
 * archived ones included so a query can ask for them. Nodes match by ID or slug. A query can expand with a
 * saved KnowledgeGraph, read the same way knowledge-graph.render selects it.
 *
 * Each query reads only its candidate rows through the indexed source: every
 * record its filters match, the endpoints of the edges on its page, and for an
 * expansion the edges of the followed types up to one hop past its depth (the
 * walk inspects that hop to report omitted records) with their endpoints.
 * `queryGraph` then runs unchanged over that partial snapshot; rows another query
 * brought in fail this query's filters or were among its candidates anyway.
 * A query filtered only by type or text reads every row of those types. */
export async function queryGraphRecords(db: Database, identity: AppIdentity, raw: GraphQueryInput) {
  const input = graphQueryInput.parse(raw);
  const types = (await db.select().from(graphTypes).orderBy(asc(graphTypes.name))).map(readType) as unknown as TypeRow[];
  const rows = candidates(db, identity.installationId, types);
  const plans = [];
  for (const query of input.queries) plans.push(await rows.read(query));
  await rows.reachAll(plans);
  return queryGraph(rows.snapshot() as never, input, { knowledgeGraph: id => savedDefinition(rows.node(id)) });
}

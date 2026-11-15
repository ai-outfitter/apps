// The GraphSource generated GraphQL resolvers read from: indexed queries on the
// Wiki tables, the same rows (and the same filters) memorySource gives over a
// whole-graph read. Rows go through nodeView/edgeView, so private fields never leave.
// Collections and relationships read only their page: WHERE, ORDER BY and LIMIT
// first + 1, and a relationship page for every parent of a level in one statement.
import {
  compareIds, type EdgeRow, type GraphRow, type GraphSource, matchesSourceAndProperties, type NodeFilter, type Order, type Page, type PropertyFilter,
  type RelationFilter, type RelationPageQuery, type RelationRow, sourceKey, type SourceRef, type TypeRow,
} from "@ai-outfitter/app-sdk/graph-graphql";
import { textMatch } from "@ai-outfitter/app-sdk/graph-query";
import { and, type AnyColumn, type Column, eq, getTableColumns, inArray, type SQL, sql } from "drizzle-orm";
import { appRecordKey, platformHost } from "@ai-outfitter/app-sdk/graph-contracts";
import { readType } from "../lib/type-metadata";
import { type Database, edgeView, nodeView } from "./graph";
import { graphEdges, graphNodes, graphTypes } from "./schema";

/** D1 binds at most 100 parameters per statement: an ID chunk (75), a type filter of
 * up to 20 IDs and the archived flag stay under it. A longer type filter is applied
 * after reading instead. Pages bind each ID list as one JSON array, so a statement
 * takes up to `parentChunk` parents. */
const chunkSize = 75, typeLimit = 20, parentChunk = 500;
/** D1 answers at most 1,000 queries per Worker invocation; a read stops before that
 * with an error that says why. */
export const maxStatements = 900;
const chunks = (values: string[], size = chunkSize) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
const byId = <T extends { id: string }>(rows: T[]) => [...new Map(rows.map(row => [row.id, row])).values()].sort((a, b) => compareIds(a.id, b.id));
const archivedIs = (column: AnyColumn, archived = "exclude") => (archived === "include" ? undefined : eq(column, archived === "only"));
const among = (column: AnyColumn, values: string[] | undefined) => (values && values.length <= typeLimit ? inArray(column, values) : undefined);
const keep = (values: string[] | undefined) => (values && values.length > typeLimit ? new Set(values) : null);
const where = (...filters: (SQL | undefined)[]) => and(...filters.filter((item): item is SQL => !!item));
// A source is the node's external key; stored properties are JSON, so json_extract keeps the
// read to the matching rows before the same check the memory source applies.
const sourceIs = (sources: SourceRef[] | undefined) => sources === undefined ? undefined : sources.length <= 20
  ? inArray(graphNodes.externalKey, sources.map(appRecordKey))
  : sql`${graphNodes.externalKey} LIKE ${`${platformHost}/apps/%`}`;
const propertiesAre = (properties: PropertyFilter | undefined) => properties === undefined ? undefined
  : and(...Object.entries(properties).slice(0, 8).map(([key, value]) => sql`json_extract(${graphNodes.properties}, ${`$.${key.replaceAll(/[^A-Za-z0-9_]/g, "_")}`}) = ${value}`));

// Page statements name the tables `n` (graph_nodes) and `e` (graph_edges).
type Alias = "n" | "e";
const col = (alias: Alias, name: string) => sql.raw(`${alias}."${name}"`);
/** Any number of IDs as one bound parameter. */
const within = (values: string[]) => sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;
const joined = (parts: SQL[], glue: string) => sql.join(parts, sql.raw(glue));
/** A stored property by a constant JSON path (inlined, so it binds no parameter). */
const prop = (alias: Alias, path: `$.${string}`) => sql`json_extract(${col(alias, "properties")}, ${sql.raw(`'${path}'`)})`;

/** The text predicate of collections and search: a case-insensitive literal substring (instr, so `%` and `_`
 * mean themselves) of a node's ID, title, slug, summary, body, website or stored properties, as graph.query
 * matches. lower() folds ASCII only. Kept to this one function so an index can answer it instead. */
export function nodeTextMatches(text: string, alias: Alias = "n") {
  return sql`(${joined(["id", "title", "slug", "summary", "body", "website", "properties"]
    .map(name => sql`instr(lower(${col(alias, name)}), lower(${text})) > 0`), " OR ")})`;
}
/** Authored retirement (properties.status or a JSON body's status), which traversal hides under EXCLUDE. */
const notRetired = (alias: Alias) => sql`(${prop(alias, "$.status")} IS NOT 'retired'
  AND (CASE WHEN json_valid(${col(alias, "body")}) THEN json_extract(${col(alias, "body")}, '$.status') END) IS NOT 'retired')`;
/** Validity columns win, then the conventional property names (validFrom/validUntil in graph-graphql). */
const validity = {
  n: { from: sql`COALESCE(json_extract(n."validity", '$.from'), ${prop("n", "$.valid_from")}, ${prop("n", "$.validFrom")})`,
    until: sql`COALESCE(json_extract(n."validity", '$.to'), ${prop("n", "$.valid_until")}, ${prop("n", "$.validUntil")}, ${prop("n", "$.valid_to")})` },
  e: { from: sql`COALESCE(e."validFrom", ${prop("e", "$.valid_from")}, ${prop("e", "$.validFrom")})`,
    until: sql`COALESCE(e."validTo", ${prop("e", "$.valid_until")}, ${prop("e", "$.validUntil")}, ${prop("e", "$.valid_to")})` },
};
/** Valid at `at`: from inclusive, until exclusive; an unreadable bound is never valid, as Date.parse's NaN. */
const validAt = (alias: Alias, at: string | undefined) => at === undefined ? undefined
  : sql`((${validity[alias].from}) IS NULL OR julianday(${validity[alias].from}) <= julianday(${at}))
    AND ((${validity[alias].until}) IS NULL OR julianday(${at}) < julianday(${validity[alias].until}))`;
/** graph.query's archived filter; `traversal` also hides retired records under EXCLUDE. */
const shown = (alias: Alias, archived: string | undefined, traversal: boolean) => archived === "include" ? undefined
  : archived === "only" ? sql`${col(alias, "archived")} = 1`
  : traversal ? sql`${col(alias, "archived")} = 0 AND ${notRetired(alias)}` : sql`${col(alias, "archived")} = 0`;
const all = (...parts: (SQL | undefined)[]) => {
  const kept = parts.filter((part): part is SQL => !!part);
  return kept.length ? joined(kept.map(part => sql`(${part})`), " AND ") : sql`1`;
};
/** ORDER BY and the keyset after the page's last row, for a page ordered by `order` over `value` (then `id`). */
const ordering = (value: SQL, id: SQL, { order, after }: Page) => {
  const direction = sql.raw(order.descending ? "DESC" : "ASC"), beyond = sql.raw(order.descending ? "<" : ">");
  // Ordered by the ID itself: one term, so the (typeId, id) index gives the order.
  if (order.field === "id") return { by: sql`${id} ${direction}`, after: after ? sql`${id} ${beyond} ${after.id}` : undefined };
  return { by: sql`${value} ${direction}, ${id} ${direction}`, after: after ? sql`(${value}, ${id}) ${beyond} (${after.value}, ${after.id})` : undefined };
};
const orderColumn = (alias: Alias, order: Order) => col(alias, order.field);

const nodeColumns = Object.entries(getTableColumns(graphNodes)) as [string, Column][];
const edgeColumns = Object.entries(getTableColumns(graphEdges)) as [string, Column][];
const selected = (alias: Alias, columns: [string, Column][]) => sql.raw(columns.map(([, column]) => `${alias}."${column.name}" AS "${alias}_${column.name}"`).join(", "));
/** A raw row's columns (prefixed by alias) as drizzle maps them: JSON parsed, booleans as booleans. */
function mapped<T>(raw: Record<string, unknown>, alias: Alias, columns: [string, Column][]) {
  return Object.fromEntries(columns.map(([key, column]) => {
    const value = raw[`${alias}_${column.name}`];
    return [key, value === null || value === undefined ? null : column.mapFromDriverValue(value)];
  })) as T;
}
const nodeRow = (raw: Record<string, unknown>) => nodeView(mapped(raw, "n", nodeColumns)) as unknown as GraphRow;
const edgeRow = (raw: Record<string, unknown>) => edgeView(mapped(raw, "e", edgeColumns)) as unknown as EdgeRow;

/** A collection's WHERE over `n`, or null when it can match nothing. */
function collectionWhere({ typeIds, ids, slugs, text, archived, at }: NodeFilter) {
  if (!typeIds.length || ids?.length === 0 || slugs?.length === 0) return null;
  // One type compares with =, so its (typeId, order column) index also gives the order.
  return all(typeIds.length === 1 ? sql`n."typeId" = ${typeIds[0]}` : sql`n."typeId" IN ${within(typeIds)}`, ids && sql`n."id" IN ${within(ids)}`, slugs && sql`n."slug" IN ${within(slugs)}`,
    text ? nodeTextMatches(text) : undefined, shown("n", archived, false), validAt("n", at));
}

/** Each parent's edges of the relationship with the node at the other end, both visible: one SELECT per direction. */
function relationHits({ parentIds, edgeTypeIds, direction, targetTypeIds, archived, at, rows }: RelationFilter, order: Order) {
  const value = rows === "node" ? orderColumn("n", order) : orderColumn("e", order), id = rows === "node" ? col("n", "id") : col("e", "id");
  const arms = (direction === "both" ? ["outgoing", "incoming"] as const : [direction]).map(way => {
    const [parent, other] = way === "outgoing" ? ["fromId", "toId"] : ["toId", "fromId"];
    // CROSS JOIN fixes the loop order: the parents' edges (graph_edges_out/in), then each far node by ID;
    // the unary + keeps the target type test off the type indexes, so no statement scans a type.
    return sql`SELECT ${col("e", parent)} AS parent, e."id" AS edgeKey, n."id" AS nodeKey, ${value} AS orderValue, ${id} AS orderId
      FROM graph_edges e CROSS JOIN graph_nodes n ON n."id" = ${col("e", other)}
      WHERE ${all(sql`${col("e", parent)} IN ${within(parentIds)}`, sql`e."typeId" IN ${within(edgeTypeIds)}`, sql`+n."typeId" IN ${within(targetTypeIds)}`,
        shown("e", archived, true), archived === "only" ? undefined : shown("n", archived, true), validAt("e", at), validAt("n", at))}`;
  });
  return joined(arms, " UNION ALL ");
}

export function databaseSource(db: Database): GraphSource {
  let statements = 0;
  const spend = (count: number) => {
    statements += count;
    if (statements > maxStatements) throw new Error(`This read needs more than ${maxStatements} database queries; select fewer relationships, hops or records`);
  };
  /** Run `read` once per chunk of `ids` (or once without it), counting statements. */
  async function chunked<T>(ids: string[] | undefined, read: (chunk: string[] | undefined) => Promise<T[]>, size = chunkSize) {
    const parts = ids ? chunks([...new Set(ids)], size) : [undefined];
    spend(parts.length);
    return (await Promise.all(parts.map(read))).flat();
  }
  const rawRows = (query: SQL) => db.all<Record<string, unknown>>(query);
  return {
    async types() {
      return byId((await db.select().from(graphTypes)).map(readType) as unknown as TypeRow[]);
    },
    async nodes({ typeIds, ids, slugs, archived, text, sources, properties }) {
      if (typeIds?.length === 0 || ids?.length === 0 || slugs?.length === 0 || sources?.length === 0) return [];
      const types = keep(typeIds), needle = text?.toLowerCase();
      // One key list (IDs, else slugs) is chunked into the statement; slugs beside IDs narrow the rows read.
      const [column, values, rest] = ids ? [graphNodes.id, ids, slugs] : [graphNodes.slug, slugs, undefined];
      const wanted = rest ? new Set(rest) : null;
      const rows = await chunked(values, chunk => db.select().from(graphNodes)
        .where(where(among(graphNodes.typeId, typeIds), archivedIs(graphNodes.archived, archived), chunk && inArray(column, chunk), sourceIs(sources), propertiesAre(properties))));
      const sourceKeys = sources ? new Set(sources.map(sourceKey)) : null;
      return byId(rows.map(nodeView) as unknown as GraphRow[])
        .filter(row => (!types || types.has(row.typeId)) && (!wanted || wanted.has(String(row.slug))) && (!needle || textMatch("node", row, needle))
          && matchesSourceAndProperties(row, sourceKeys, properties));
    },
    async edges({ typeIds, ids, fromIds, toIds, archived }) {
      if (typeIds?.length === 0 || ids?.length === 0) return [];
      const types = keep(typeIds);
      const read = (column: AnyColumn, values: string[] | undefined) => chunked(values, chunk => db.select().from(graphEdges)
        .where(where(among(graphEdges.typeId, typeIds), archivedIs(graphEdges.archived, archived), chunk && inArray(column, chunk))));
      // An edge matches fromIds or toIds; with neither, ids (if any) select it.
      const rows = fromIds || toIds
        ? (await Promise.all([fromIds?.length ? read(graphEdges.fromId, fromIds) : [], toIds?.length ? read(graphEdges.toId, toIds) : []])).flat()
        : await read(graphEdges.id, ids);
      const wanted = ids ? new Set(ids) : null;
      return byId(rows.map(edgeView) as unknown as EdgeRow[]).filter(row => (!types || types.has(row.typeId)) && (!wanted || wanted.has(row.id)));
    },
    async nodePage(query) {
      const filter = collectionWhere(query);
      if (!filter || query.first < 0) return [];
      const { by, after } = ordering(orderColumn("n", query.order), col("n", "id"), query);
      spend(1);
      const rows = await rawRows(sql`SELECT ${selected("n", nodeColumns)} FROM graph_nodes n WHERE ${all(filter, after)} ORDER BY ${by} LIMIT ${query.first + 1}`);
      return rows.map(nodeRow);
    },
    async nodeCount(query) {
      const filter = collectionWhere(query);
      if (!filter) return 0;
      spend(1);
      const [row] = await rawRows(sql`SELECT COUNT(*) AS count FROM graph_nodes n WHERE ${filter}`);
      return Number(row?.count ?? 0);
    },
    async relationPage(query: RelationPageQuery) {
      if (!query.edgeTypeIds.length || !query.targetTypeIds.length || !query.parentIds.length) return [];
      return chunked(query.parentIds, async parentIds => {
        const { by, after } = ordering(sql.raw("orderValue"), sql.raw("orderId"), query);
        // One row per far node (its lowest edge ID) or per edge, then each parent's first + 1 in page order.
        const rows = await rawRows(sql`WITH hits AS (${relationHits({ ...query, parentIds: parentIds as string[] }, query.order)}),
          once AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY parent, ${sql.raw(query.rows === "node" ? "nodeKey" : "edgeKey")} ORDER BY edgeKey) AS dup FROM hits),
          ranked AS (SELECT parent, edgeKey, nodeKey, ROW_NUMBER() OVER (PARTITION BY parent ORDER BY ${by}) AS pos FROM once WHERE ${all(sql`dup = 1`, after)})
          SELECT ranked.parent AS parent, ${selected("e", edgeColumns)}, ${selected("n", nodeColumns)}
          FROM ranked JOIN graph_edges e ON e."id" = ranked.edgeKey JOIN graph_nodes n ON n."id" = ranked.nodeKey
          WHERE ranked.pos <= ${query.first + 1} ORDER BY ranked.parent, ranked.pos`);
        return rows.map((raw): RelationRow => ({ parentId: String(raw.parent), edge: edgeRow(raw), node: nodeRow(raw) }));
      }, parentChunk);
    },
    async relationCount(query) {
      if (!query.edgeTypeIds.length || !query.targetTypeIds.length || !query.parentIds.length) return new Map();
      const rows = await chunked(query.parentIds, parentIds => rawRows(sql`WITH hits AS (${relationHits({ ...query, parentIds: parentIds as string[] }, { field: "id", descending: false })})
        SELECT parent, COUNT(DISTINCT ${sql.raw(query.rows === "node" ? "nodeKey" : "edgeKey")}) AS count FROM hits GROUP BY parent`), parentChunk);
      return new Map(rows.map(row => [String(row.parent), Number(row.count)]));
    },
  };
}

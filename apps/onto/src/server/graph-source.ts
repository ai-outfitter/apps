// The GraphSource generated GraphQL resolvers read from: indexed queries on the
// Wiki tables, the same rows (and the same filters) memorySource gives over a
// whole-graph read. Rows go through nodeView/edgeView, so private fields never leave.
// Collections and relationships read only their page: WHERE (the connection's filter
// included), ORDER BY and LIMIT first + 1 (the row past the page says more follow), and a
// relationship page for every parent of a level in one statement, whether one hop, any edge
// type (Node.edges) or a projection's two. A relationship page asked for its count carries it
// from the same statement, for every parent; a collection page asked for its count reads it beside the page.
import {
  compareIds, type EdgeRow, type GraphRow, type GraphSource, groupBy, matchesSourceAndProperties, type NodeFilter, orders, type Page, pageOf, type PropertyFilter,
  type RelationFilter, type RelationPage, type RelationPageQuery, sourceKey, type SourceRef, type TypeRow,
} from "@ai-outfitter/app-sdk/graph-graphql";
import { edgeFilterFields, type FilterFields, nodeFilterFields } from "@ai-outfitter/app-sdk/graph-filter";
import { containsInsensitive, type FilterColumns, filterSql, joined, rowsAfter, within } from "@ai-outfitter/app-sdk/graph-filter-sql";
import { textMatch } from "@ai-outfitter/app-sdk/graph-query";
import { and, type AnyColumn, type Column, eq, getTableColumns, inArray, type SQL, sql } from "drizzle-orm";
import { appRecordKey, platformHost } from "@ai-outfitter/app-sdk/graph-contracts";
import { readType } from "../lib/type-metadata";
import { type Database, edgeView, nodeView } from "./graph";
import { graphEdges, graphNodes, graphTypes } from "./schema";

/** D1 binds at most 100 parameters per statement: an ID chunk (75), a type filter of
 * up to 20 IDs and the archived flag stay under it. A longer type filter is applied
 * after reading instead. Pages bind each ID list as one JSON array, so a statement
 * takes up to `parentChunk` parents: a relationship page binds at most 6 lists (20 through
 * a relator), a filter's conditions (at most 20), the keyset (2) and the limit. */
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

// Page statements name graph_nodes `n` (a projection's relator `r`) and graph_edges `e` (a projection's first hop `e1`).
type NodeAlias = "n" | "r";
type EdgeAlias = "e" | "e1";
type Alias = NodeAlias | EdgeAlias;
const isNode = (alias: Alias): alias is NodeAlias => alias === "n" || alias === "r";
const col = (alias: Alias, name: string) => sql.raw(`${alias}."${name}"`);
const union = (selects: SQL[]) => sql.join(selects, sql.raw(" UNION ALL "));
/** A stored property by a constant JSON path (inlined, so it binds no parameter). */
const prop = (alias: Alias, path: `$.${string}`) => sql`json_extract(${col(alias, "properties")}, ${sql.raw(`'${path}'`)})`;

/** The text predicate of collections and search: a case-insensitive literal substring (instr, so `%` and `_`
 * mean themselves) of a node's ID, title, slug, summary, body, website or stored properties, as graph.query
 * matches. lower() folds ASCII only. Kept to this one function so an index can answer it instead. */
export function nodeTextMatches(text: string, alias: NodeAlias = "n") {
  return joined(["id", "title", "slug", "summary", "body", "website", "properties"].map(name => containsInsensitive(col(alias, name), text)), " OR ");
}
/** Authored retirement (properties.status or a JSON body's status), which traversal hides under EXCLUDE. */
const notRetired = (alias: Alias) => sql`(${prop(alias, "$.status")} IS NOT 'retired'
  AND (CASE WHEN json_valid(${col(alias, "body")}) THEN json_extract(${col(alias, "body")}, '$.status') END) IS NOT 'retired')`;
/** Validity columns win, then the conventional property names (validFrom/validUntil in graph-graphql). */
const validity = (alias: Alias) => isNode(alias)
  ? { from: sql`COALESCE(json_extract(${col(alias, "validity")}, '$.from'), ${prop(alias, "$.valid_from")}, ${prop(alias, "$.validFrom")})`,
    until: sql`COALESCE(json_extract(${col(alias, "validity")}, '$.to'), ${prop(alias, "$.valid_until")}, ${prop(alias, "$.validUntil")}, ${prop(alias, "$.valid_to")})` }
  : { from: sql`COALESCE(${col(alias, "validFrom")}, ${prop(alias, "$.valid_from")}, ${prop(alias, "$.validFrom")})`,
    until: sql`COALESCE(${col(alias, "validTo")}, ${prop(alias, "$.valid_until")}, ${prop(alias, "$.validUntil")}, ${prop(alias, "$.valid_to")})` };
/** `at` as a SQL literal: its instant in canonical ISO-8601, which holds only digits and `-:.TZ`, so it is inlined
 * and a statement spends no parameters on it however many records it tests. */
function instant(at: string) {
  const time = Date.parse(at);
  const text = Number.isNaN(time) ? "" : new Date(time).toISOString();
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(text)) throw new Response("at is an ISO-8601 date or date-time", { status: 400 });
  return sql.raw(`'${text}'`);
}
/** Valid at `at`: from inclusive, until exclusive; an unreadable bound is never valid, as Date.parse's NaN. */
const validAt = (alias: Alias, at: string | undefined) => {
  if (at === undefined) return undefined;
  const { from, until } = validity(alias), when = instant(at);
  return sql`((${from}) IS NULL OR julianday(${from}) <= julianday(${when})) AND ((${until}) IS NULL OR julianday(${when}) < julianday(${until}))`;
};
/** graph.query's archived filter; `traversal` also hides retired records under EXCLUDE. */
const shown = (alias: Alias, archived: string | undefined, traversal: boolean) => archived === "include" ? undefined
  : archived === "only" ? sql`${col(alias, "archived")} = 1`
  : traversal ? sql`${col(alias, "archived")} = 0 AND ${notRetired(alias)}` : sql`${col(alias, "archived")} = 0`;
const all = (...parts: (SQL | undefined)[]) => {
  const kept = parts.filter((part): part is SQL => !!part);
  return kept.length ? joined(kept, " AND ") : sql`1`;
};
/** ORDER BY and the keyset after the page's last row, for a page in its order: the order's column as `column(field)`, then `id`. */
const ordering = (column: (field: string) => SQL, { orderBy, after }: Page) => {
  const order = orders[orderBy], value = column(order.field), id = column("id");
  const direction = sql.raw(order.descending ? "DESC" : "ASC"), byId = order.field === "id";
  // Ordered by the ID itself: one term, so the (typeId, id) index gives the order. No order column holds NULL.
  return { by: byId ? sql`${id} ${direction}` : sql`${value} ${direction}, ${id} ${direction}`,
    after: after ? rowsAfter(byId ? null : value, id, order.descending, after, false) : undefined };
};

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

/** A connection filter's fields as columns: `name(field)` is the SQL that holds the field. Each condition binds
 * one parameter and a checked filter has at most 20, so a page statement stays far below D1's 100. */
const filterColumns = (fields: FilterFields, name: (field: string) => SQL): FilterColumns =>
  Object.fromEntries(Object.entries(fields).map(([field, kind]) => [field, { column: name(field), kind }]));
const nodeFilter = filterColumns(nodeFilterFields, field => col("n", field));
/** The listed record's filter and order fields, carried out of a relationship's hits as `f_<field>`. */
const carried = (fields: FilterFields) => filterColumns(fields, field => sql.raw(`"f_${field}"`));
const carriedColumns = { node: carried(nodeFilterFields), edge: carried(edgeFilterFields) };
/** Every field a page may filter or order by, selected from the listed record's alias. */
const carry = (alias: "n" | "e", fields: FilterFields) => sql.raw(Object.keys(fields).map(field => `${alias}."${field}" AS "f_${field}"`).join(", "));

/** A collection's WHERE over `n`. One type compares with =, so its (typeId, order column) index also gives the order and answers
 * the filter's fields; every type (no `typeIds`) has no type test, so the (order column, id) index gives the order. */
function collectionWhere({ typeIds, ids, text, archived, at, filter }: NodeFilter) {
  const ofType = typeIds && (typeIds.length === 1 ? sql`n."typeId" = ${typeIds[0]}` : sql`n."typeId" IN ${within(typeIds)}`);
  return all(ofType, ids && sql`n."id" IN ${within(ids)}`,
    filterSql(filter, nodeFilter), text ? nodeTextMatches(text) : undefined, shown("n", archived, false), validAt("n", at));
}

type Way = "outgoing" | "incoming";
const ways = (direction: RelationFilter["direction"]): Way[] => (direction === "both" ? ["outgoing", "incoming"] : [direction]);
/** The edge columns at the near and far end of an edge followed `way`. */
const ends = (way: Way) => (way === "outgoing" ? { near: "fromId", far: "toId" } : { near: "toId", far: "fromId" });

/** Each parent's edges of the relationship with the node at the other end, both visible: one SELECT per direction
 * (per pair of directions through a relator). A row carries the listed record's filter and order fields. */
function relationHits({ parentIds, edgeTypeIds, direction, targetTypeIds, archived, at, rows, through }: RelationFilter) {
  const fields = rows === "node" ? carry("n", nodeFilterFields) : carry("e", edgeFilterFields);
  // ONLY asks for archived edges; their endpoints may be active.
  const node = (alias: NodeAlias) => (archived === "only" ? undefined : shown(alias, archived, true));
  const far = (way: Way) => {
    const { near, far: other } = ends(way);
    return { near, join: sql`CROSS JOIN graph_nodes n ON n."id" = ${col("e", other)}`,
      where: all(sql`e."typeId" IN ${within(edgeTypeIds)}`, sql`+n."typeId" IN ${within(targetTypeIds)}`, shown("e", archived, true), node("n"), validAt("e", at), validAt("n", at)) };
  };
  // CROSS JOIN fixes the loop order: the parents' edges (graph_edges_out/in), then each far node by ID;
  // the unary + keeps the type tests off the type indexes, so no statement scans a type.
  if (!through) return union(ways(direction).map(way => {
    const hop = far(way);
    return sql`SELECT ${col("e", hop.near)} AS parent, e."id" AS edgeKey, n."id" AS nodeKey, ${fields}
      FROM graph_edges e ${hop.join} WHERE ${all(sql`${col("e", hop.near)} IN ${within(parentIds)}`, hop.where)}`;
  }));
  // Two hops: the parents' edges to their relators (by ID), each relator's edges (graph_edges_out/in), each far node by ID.
  return union(ways("both").flatMap(first => ways(direction).map(second => {
    const start = ends(first), hop = far(second);
    return sql`SELECT ${col("e1", start.near)} AS parent, e."id" AS edgeKey, n."id" AS nodeKey, ${fields}
      FROM graph_edges e1 CROSS JOIN graph_nodes r ON r."id" = ${col("e1", start.far)}
      CROSS JOIN graph_edges e ON ${col("e", hop.near)} = r."id" ${hop.join}
      WHERE ${all(sql`${col("e1", start.near)} IN ${within(parentIds)}`, sql`e1."typeId" IN ${within(through.edgeTypeIds)}`, sql`+r."typeId" IN ${within(through.nodeTypeIds)}`,
        shown("e1", archived, true), node("r"), validAt("e1", at), validAt("r", at), hop.where, sql`n."id" <> ${col("e1", start.near)}`)}`;
  })));
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
  const nodeCount = async (query: NodeFilter) => {
    spend(1);
    const [row] = await rawRows(sql`SELECT COUNT(*) AS count FROM graph_nodes n WHERE ${collectionWhere(query)}`);
    return Number(row?.count ?? 0);
  };
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
      const { by, after } = ordering(field => col("n", field), query);
      spend(1);
      // The page stops at its LIMIT and a count reads every match, so a counted page reads its count beside it.
      const [rows, count] = await Promise.all([
        rawRows(sql`SELECT ${selected("n", nodeColumns)} FROM graph_nodes n WHERE ${all(collectionWhere(query), after)} ORDER BY ${by} LIMIT ${query.first + 1}`),
        query.count ? nodeCount(query) : undefined,
      ]);
      const page = pageOf(rows.map(nodeRow), query.first);
      return count === undefined ? page : { ...page, count };
    },
    nodeCount,
    async relationPage(query: RelationPageQuery) {
      const key = sql.raw(query.rows === "node" ? "nodeKey" : "edgeKey");
      const records = sql`${selected("e", edgeColumns)}, ${selected("n", nodeColumns)}`;
      return chunked(query.parentIds, async chunk => {
        const parentIds = chunk as string[];
        const { by, after } = ordering(field => sql.raw(`"f_${field}"`), query);
        // One row per far node (its lowest edge ID) or per edge that passes the filter (firsts), then each parent's first + 1
        // after the cursor in page order (ranked). Counted, the rows hang off each parent's total, taken before the cursor
        // is applied, so a parent with no row after it still answers its count (with no edge beside it).
        const page = query.count
          ? sql`SELECT totals.parent AS parent, totals.total AS total, ${records}
            FROM (SELECT parent, COUNT(*) AS total FROM firsts GROUP BY parent) totals
            LEFT JOIN ranked ON ranked.parent = totals.parent AND ranked.pos <= ${query.first + 1}
            LEFT JOIN graph_edges e ON e."id" = ranked.edgeKey LEFT JOIN graph_nodes n ON n."id" = ranked.nodeKey
            ORDER BY totals.parent, ranked.pos`
          : sql`SELECT ranked.parent AS parent, ${records}
            FROM ranked JOIN graph_edges e ON e."id" = ranked.edgeKey JOIN graph_nodes n ON n."id" = ranked.nodeKey
            WHERE ranked.pos <= ${query.first + 1} ORDER BY ranked.parent, ranked.pos`;
        const found = groupBy(await rawRows(sql`WITH hits AS (${relationHits({ ...query, parentIds })}),
          once AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY parent, ${key} ORDER BY edgeKey) AS dup FROM hits WHERE ${all(filterSql(query.filter, carriedColumns[query.rows]))}),
          firsts AS (SELECT * FROM once WHERE dup = 1),
          ranked AS (SELECT parent, edgeKey, nodeKey, ROW_NUMBER() OVER (PARTITION BY parent ORDER BY ${by}) AS pos FROM firsts WHERE ${all(after)})
          ${page}`), raw => String(raw.parent));
        // Counted, every parent asked for answers: one without a row in the relationship counts 0.
        return (query.count ? parentIds : [...found.keys()]).map((parentId): RelationPage => {
          const raws = found.get(parentId) ?? [];
          const rows = raws.filter(raw => raw.e_id != null).map(raw => ({ parentId, edge: edgeRow(raw), node: nodeRow(raw) }));
          return { parentId, ...pageOf(rows, query.first), ...(query.count ? { count: Number(raws[0]?.total ?? 0) } : {}) };
        });
      }, parentChunk);
    },
    async relationCount(query) {
      const key = sql.raw(query.rows === "node" ? "nodeKey" : "edgeKey");
      const rows = await chunked(query.parentIds, parentIds => rawRows(sql`WITH hits AS (${relationHits({ ...query, parentIds: parentIds as string[] })})
        SELECT parent, COUNT(DISTINCT ${key}) AS count FROM hits WHERE ${all(filterSql(query.filter, carriedColumns[query.rows]))} GROUP BY parent`), parentChunk);
      return new Map(rows.map(row => [String(row.parent), Number(row.count)]));
    },
  };
}

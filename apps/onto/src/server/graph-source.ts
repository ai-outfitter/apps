// The GraphSource generated GraphQL resolvers read from: indexed queries on the
// Wiki tables, the same rows (and the same filters) memorySource gives over a
// whole-graph read. Rows go through nodeView/edgeView, so private fields never leave.
import { compareIds, type EdgeRow, type GraphRow, type GraphSource, matchesSourceAndProperties, type PropertyFilter, sourceKey, type SourceRef, type TypeRow } from "@ai-outfitter/app-sdk/graph-graphql";
import { textMatch } from "@ai-outfitter/app-sdk/graph-query";
import { and, type AnyColumn, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { appRecordKey, platformHost } from "@ai-outfitter/app-sdk/graph-contracts";
import { readType } from "../lib/type-metadata";
import { type Database, edgeView, nodeView } from "./graph";
import { graphEdges, graphNodes, graphTypes } from "./schema";

/** D1 binds at most 100 parameters per statement: an ID chunk (75), a type filter of
 * up to 20 IDs and the archived flag stay under it. A longer type filter is applied
 * after reading instead. */
const chunkSize = 75, typeLimit = 20;
/** D1 answers at most 1,000 queries per Worker invocation; a read stops before that
 * with an error that says why. */
export const maxStatements = 900;
const chunks = (values: string[]) => Array.from({ length: Math.ceil(values.length / chunkSize) }, (_, index) => values.slice(index * chunkSize, (index + 1) * chunkSize));
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

export function databaseSource(db: Database): GraphSource {
  let statements = 0;
  /** Run `read` once per chunk of `ids` (or once without it), counting statements. */
  async function chunked<T>(ids: string[] | undefined, read: (chunk: string[] | undefined) => Promise<T[]>) {
    const parts = ids ? chunks([...new Set(ids)]) : [undefined];
    statements += parts.length;
    if (statements > maxStatements) throw new Error(`This read needs more than ${maxStatements} database queries; select fewer relationships, hops or records`);
    return (await Promise.all(parts.map(read))).flat();
  }
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
  };
}

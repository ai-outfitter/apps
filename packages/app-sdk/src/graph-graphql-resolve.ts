// Record-level rules the generated resolvers share: visibility (graph.query's
// archived/retired rules), validity at a time, traversal and paging.
import { defaultFieldResolver, type GraphQLField, GraphQLError, type GraphQLNamedType, GraphQLObjectType, type GraphQLResolveInfo, responsePathAsArray } from "graphql";
import { type ArchivedFilter, type EdgeRow, type GraphLoader, graphLoader, type GraphSource, type Keyset, validAt, validFrom, validUntil, visible } from "./graph-graphql-source";
import { checkFilter, type FilterFields, filterConditions, type RecordFilter } from "./graph-filter";
import { keysetCursor, type OrderName, orders, readKeyset } from "./graph-order";

export { validAt, validFrom, validUntil, visible };
export type GraphContext = {
  loader: GraphLoader;
  /** Lists stop at `maxRecords` and report the cut; execution stops past `maxFields`
   * resolved fields or `maxBytes` of resolved strings (aliases multiply work). */
  budget: { records: number; maxRecords: number; fields: number; maxFields: number; bytes: number; maxBytes: number; exceeded: boolean };
  truncated: (string | number)[][];
  /** Each connection page by response path (the cursor it started after, each record's cursor), so a cut page can continue. */
  pages: Map<string, { after: string | null; cursors: string[] }>;
  [key: string]: unknown;
};
export type GraphBudget = { maxRecords?: number; maxFields?: number; maxBytes?: number };
export function graphContext(source: GraphSource, extra: Record<string, unknown> = {}, { maxRecords = 5_000, maxFields = 200_000, maxBytes = 4 * 1024 * 1024 }: GraphBudget = {}): GraphContext {
  return { ...extra, loader: graphLoader(source), budget: { records: 0, maxRecords, fields: 0, maxFields, bytes: 0, maxBytes, exceeded: false }, truncated: [], pages: new Map() };
}
export const pathKey = (path: GraphQLResolveInfo["path"] | (string | number)[]) => JSON.stringify(Array.isArray(path) ? path : responsePathAsArray(path));


/** Spend the record budget; a list past it is cut and its path reported. */
export function take<T>(context: GraphContext, info: GraphQLResolveInfo, rows: T[]) {
  if (context.budget.exceeded) return [];
  const left = Math.max(0, context.budget.maxRecords - context.budget.records);
  context.budget.records += Math.min(left, rows.length);
  if (rows.length <= left) return rows;
  context.truncated.push(responsePathAsArray(info.path));
  return rows.slice(0, left);
}

export type TraverseArgs = { archived?: ArchivedFilter; at?: string };
/** Edges of the given types touching a node, with the node at the other end, both visible. */
export async function traverse(context: GraphContext, nodeId: string, edgeTypeIds: string[] | null, direction: "outgoing" | "incoming" | "both", args: TraverseArgs) {
  const directions = direction === "both" ? (["outgoing", "incoming"] as const) : [direction];
  const lists = await Promise.all(directions.map(async way => (await context.loader.edges(edgeTypeIds, way, nodeId)).map(edge => ({ edge, way }))));
  const seen = new Set<string>();
  const edges = lists.flat().filter(({ edge }) => !seen.has(edge.id) && !!seen.add(edge.id) && visible(edge, args.archived) && validAt(edge, args.at));
  const others = await Promise.all(edges.map(({ edge, way }) => context.loader.node(way === "outgoing" ? edge.toId : edge.fromId)));
  return edges.flatMap(({ edge }, index) => {
    const other = others[index];
    // ONLY asks for archived edges; their endpoints may be active.
    const shown = other && (args.archived === "only" || visible(other, args.archived)) && validAt(other, args.at);
    return shown ? [{ edge: edge as EdgeRow, other }] : [];
  });
}

const badInput = (message: string) => new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
/** At most 200 IDs (or slugs) per argument, as graph.query takes. */
export function idList(ids: string[] | null | undefined, name = "ids") {
  if (ids && ids.length > 200) throw badInput(`${name} takes at most 200 ${name === "ids" ? "IDs" : name}`);
  return ids ?? undefined;
}
/** A `filter` argument checked against the fields it may name (BAD_USER_INPUT otherwise); nothing when it holds no condition. */
export function checkedFilter(filter: unknown, fields: FilterFields): { filter?: RecordFilter } {
  if (filter === null || filter === undefined) return {};
  try { checkFilter(filter, fields); }
  catch (error) { throw badInput(error instanceof Error ? error.message : "Invalid filter"); }
  return filterConditions(filter) ? { filter } : {};
}
export type PageArgs = { first?: number | null; after?: string | null };
export type OrderedPageArgs = PageArgs & { orderBy?: OrderName | null };
/** Where a page ordered by `orderBy` resumes: its cursor's record (BAD_USER_INPUT unless the cursor names this order). */
export const pageAfter = (orderBy: string, after: string | null | undefined) => (after ? readKeyset(orderBy, after, badInput) : null);
const idKey = (id: string): Keyset => ({ value: id, id });
/** The page size (default 100, at most 500) and, for a page in ID order, the ID it starts after. */
export function pageStart({ first, after }: PageArgs) {
  const size = first ?? 100;
  if (size < 0 || size > 500) throw badInput("first must be between 0 and 500");
  return { first: size, start: pageAfter("ID_ASC", after)?.id ?? null };
}
/** The page an ordered connection reads: its order, size and the record it resumes after. */
export function orderedStart(args: OrderedPageArgs) {
  const orderBy = args.orderBy ?? "ID_ASC";
  return { orderBy, order: orders[orderBy], first: pageStart({ first: args.first }).first, after: pageAfter(orderBy, args.after) };
}
/** A Relay connection over the ordered `rows` a source read (one past the page, to tell whether more follow): `nodes`,
 * the same records as `edges` with each one's cursor, `pageInfo` and `totalCount` (`count` runs only when it is selected).
 * Paging is forward only, so a page has a previous one exactly when it started after a cursor. Noted for fitResponse to
 * continue from any record kept. */
export function orderedPage<T>(context: GraphContext, info: GraphQLResolveInfo, rows: T[], key: (row: T) => Keyset, start: { orderBy: string; first: number },
  after: string | null | undefined, count: () => number | Promise<number>) {
  const nodes = take(context, info, rows.slice(0, start.first));
  const cursors = nodes.map(row => keysetCursor(start.orderBy, key(row)));
  context.pages.set(pathKey(info.path), { after: after ?? null, cursors });
  return {
    nodes, edges: nodes.map((node, index) => ({ cursor: cursors[index], node })),
    pageInfo: { hasNextPage: rows.length > nodes.length, hasPreviousPage: !!after, startCursor: cursors[0] ?? null, endCursor: cursors.at(-1) ?? null },
    totalCount: count,
  };
}
/** A connection over the ID-ordered `rows` after `start` (one past the page), for a collection written by hand. */
export function page<T>(context: GraphContext, info: GraphQLResolveInfo, rows: T[], idOf: (row: T) => string, first: number, start: string | null, count: () => number | Promise<number>) {
  return orderedPage(context, info, rows, row => idKey(idOf(row)), { orderBy: "ID_ASC", first }, start === null ? null : keysetCursor("ID_ASC", idKey(start)), count);
}

export const responseTooLarge = () => new GraphQLError("The query resolves more than this request may return; select fewer fields, aliases or records", { extensions: { code: "RESPONSE_TOO_LARGE" } });
/** Count fields and string bytes; false once the budget is spent. */
function spend(budget: GraphContext["budget"], fields: number, bytes: number) {
  budget.fields += fields;
  budget.bytes += bytes;
  budget.exceeded ||= budget.fields > budget.maxFields || budget.bytes > budget.maxBytes;
  return !budget.exceeded;
}
const metered = new WeakSet<GraphQLField<unknown, unknown>>();
/** Count every resolved field and string byte against the request budget. */
export function meterFields(types: Iterable<GraphQLNamedType>) {
  for (const type of types) {
    if (!(type instanceof GraphQLObjectType) || type.name.startsWith("__")) continue;
    for (const field of Object.values(type.getFields())) {
      if (metered.has(field)) continue;
      metered.add(field);
      const inner = field.resolve ?? defaultFieldResolver;
      field.resolve = (source, args, context, info) => {
        const budget = (context as Partial<GraphContext> | undefined)?.budget;
        // Past the budget nothing more resolves; the request answers RESPONSE_TOO_LARGE.
        if (budget && !spend(budget, 1, 0)) return null;
        const value = inner(source, args, context, info);
        if (budget && typeof value === "string" && !spend(budget, 0, value.length)) return null;
        return value;
      };
    }
  }
}

/** The cursor after the first `kept` records of the page at `path`. */
export function cursorAfter(context: GraphContext, path: (string | number)[], kept: number) {
  const page = context.pages.get(pathKey(path));
  return (kept ? page?.cursors[kept - 1] : page?.after) ?? null;
}

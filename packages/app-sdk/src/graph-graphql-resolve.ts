// Record-level rules the generated resolvers share: visibility (graph.query's
// archived/retired rules), validity at a time, traversal and paging.
import { defaultFieldResolver, type GraphQLField, GraphQLError, type GraphQLNamedType, GraphQLObjectType, type GraphQLResolveInfo, responsePathAsArray } from "graphql";
import { type ArchivedFilter, compareIds, type EdgeRow, type GraphLoader, graphLoader, type GraphRow, type GraphSource, visible } from "./graph-graphql-source";

export { visible };
export type GraphContext = {
  loader: GraphLoader;
  /** Lists stop at `maxRecords` and report the cut; execution stops past `maxFields`
   * resolved fields or `maxBytes` of resolved strings (aliases multiply work). */
  budget: { records: number; maxRecords: number; fields: number; maxFields: number; bytes: number; maxBytes: number; exceeded: boolean };
  truncated: (string | number)[][];
  /** Each connection page by response path (where it started, its record IDs), so a cut page can continue. */
  pages: Map<string, { after: string | null; ids: string[] }>;
  [key: string]: unknown;
};
export type GraphBudget = { maxRecords?: number; maxFields?: number; maxBytes?: number };
export function graphContext(source: GraphSource, extra: Record<string, unknown> = {}, { maxRecords = 5_000, maxFields = 200_000, maxBytes = 4 * 1024 * 1024 }: GraphBudget = {}): GraphContext {
  return { ...extra, loader: graphLoader(source), budget: { records: 0, maxRecords, fields: 0, maxFields, bytes: 0, maxBytes, exceeded: false }, truncated: [], pages: new Map() };
}
export const pathKey = (path: GraphQLResolveInfo["path"] | (string | number)[]) => JSON.stringify(Array.isArray(path) ? path : responsePathAsArray(path));

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

export const cursorOf = (id: string) => btoa(encodeURIComponent(id)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function decode(cursor: string) {
  try { return decodeURIComponent(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))); }
  catch { throw badInput("Invalid cursor"); }
}
const badInput = (message: string) => new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
/** At most 200 IDs (or slugs) per argument, as graph.query takes. */
export function idList(ids: string[] | null | undefined, name = "ids") {
  if (ids && ids.length > 200) throw badInput(`${name} takes at most 200 ${name === "ids" ? "IDs" : name}`);
  return ids ?? undefined;
}
export type PageArgs = { first?: number | null; after?: string | null };
/** The page size (default 100, at most 500) and the ID the page starts after. */
export function pageStart({ first, after }: PageArgs) {
  const size = first ?? 100;
  if (size < 0 || size > 500) throw badInput("first must be between 0 and 500");
  return { first: size, start: after ? decode(after) : null };
}
/** The first `first` of the ID-ordered `rows` after `start`, noted for fitResponse to continue. */
export function page<T>(context: GraphContext, info: GraphQLResolveInfo, rows: T[], idOf: (row: T) => string, first: number, start: string | null) {
  const nodes = take(context, info, rows.slice(0, first));
  const ids = nodes.map(idOf);
  context.pages.set(pathKey(info.path), { after: start, ids });
  const last = ids.at(-1);
  return { nodes, pageInfo: { endCursor: last ? cursorOf(last) : null, hasNextPage: rows.length > nodes.length } };
}
/** ID-ordered page of a connection; counts everything that matched. */
export function connection(context: GraphContext, info: GraphQLResolveInfo, rows: GraphRow[], args: PageArgs) {
  const { first, start } = pageStart(args);
  const unique = [...new Map(rows.map(row => [row.id, row])).values()].sort((a, b) => compareIds(a.id, b.id));
  const rest = start === null ? unique : unique.filter(row => row.id > start);
  return { ...page(context, info, rest, row => row.id, first, start), aggregate: { count: unique.length } };
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
  const id = kept ? page?.ids[kept - 1] : page?.after;
  return id ? cursorOf(id) : null;
}

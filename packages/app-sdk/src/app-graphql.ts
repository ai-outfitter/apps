// An app serves its own records over `graph.graphql`, the action, input and result a
// Wiki serves, so the platform reads every app the way it reads a Wiki: one document
// per app. The app builds a graphql-js schema (tableType for its tables) and mounts
// graphqlAction(schema) in its actionAPI; serveGraphql runs it through the same parse,
// validation, depth, field and byte limits as the Wiki's generated schema. Reads go
// through graph.graphql (query operations only); an app that serves writes adds a
// Mutation type (mutationField) and mounts mutateAction(schema) as graph.mutate,
// which runs mutation operations only, as a write.
// An app that serves it declares the `graph.serve` capability. A table whose rows
// are not all readable by every member passes `scope`, which narrows every read of it.
import { and, asc, count, getTableColumns, gt, inArray, like, or, type SQL } from "drizzle-orm";
import type { BaseSQLiteDatabase, SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  GraphQLBoolean, GraphQLEnumType, GraphQLError, type GraphQLFieldConfig, type GraphQLFieldConfigArgumentMap, type GraphQLFieldConfigMap, GraphQLFloat, GraphQLID,
  GraphQLInputObjectType, type GraphQLInputType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, type GraphQLOutputType, type GraphQLScalarType,
  type GraphQLSchema, GraphQLString, getOperationAST, print, responsePathAsArray,
} from "graphql";
import type { TadaDocumentNode } from "gql.tada";
import { z } from "zod";
import { type ActionContext, defineAction } from "./actions";
import { executeGraphQuery, type GraphGraphqlError, type GraphGraphqlInput, graphGraphqlInput, graphGraphqlResult, graphqlNames } from "./graph-graphql";
import { type GraphContext, idList, meterFields, type PageArgs, page, pageStart } from "./graph-graphql-resolve";
import { DateTimeScalar, JSONScalar } from "./graph-graphql-scalars";
import { Aggregate, PageInfo } from "./graph-graphql-schema";

export { type GraphGraphqlError, type GraphGraphqlResult, graphGraphqlAction, graphGraphqlInput, graphGraphqlResult } from "./graph-graphql";
/** The platform reads `graph.graphql` only from installations that declare this. */
export const graphServeCapability = "graph.serve";

/** The action an app mounts to serve mutations (mutateAction); the platform calls it as a write. */
export const graphMutateAction = "graph.mutate";
/** graph.mutate's input: graph.graphql's, but its variables may carry up to 256 KiB, as an action call may. */
export const graphMutateInput = graphGraphqlInput.extend({
  variables: z.record(z.string(), z.json()).optional()
    .refine(variables => !variables || new TextEncoder().encode(JSON.stringify(variables)).length <= 262144, "variables may be at most 256 KiB"),
});

/** `context` is the resolvers' context; tableType fields read `db()` from it. `operation` is the only kind
 * the request may run (default query). */
export type ServeGraphqlArgs = Omit<GraphGraphqlInput, "variables"> & {
  variables?: Record<string, unknown>; schema: GraphQLSchema; context?: Record<string, unknown>; operation?: "query" | "mutation";
};
/** Run one graph.graphql (or graph.mutate) request over an app's own schema. Every field and string the
 * schema resolves counts against the request's budget, as on a Wiki. An app's own pages run their
 * documents through this too, in process, so the UI and agents share one document. */
export function serveGraphql({ schema, context, operation, ...input }: ServeGraphqlArgs) {
  meterFields(Object.values(schema.getTypeMap()));
  return executeGraphQuery({ schema, context, operation, ...(operation === "mutation" ? graphMutateInput : graphGraphqlInput).parse(input) });
}

/** The codes for a request the document or its variables made invalid: the caller's fault, a 400. */
const inputCodes = new Set(["BAD_USER_INPUT", "GRAPHQL_VALIDATION_FAILED", "GRAPHQL_PARSE_FAILED", "OPERATION_NOT_ALLOWED", "QUERY_TOO_DEEP", "QUERY_TOO_COMPLEX"]);

/** The Response a route answers for a document's first error, or the Error to rethrow (a 500): a field's
 * refusal keeps its status and text; invalid input, including a variable the document's type rejects (an
 * error with no code and no path), is an opaque 400; a response too large to return, which a mutation has
 * already written, is a 500 that says so. */
function documentError(error: GraphGraphqlError): Response | Error {
  const { code, status } = error.extensions ?? {};
  if (code === "REFUSED" && typeof status === "number") return new Response(error.message, { status });
  if (code === "RESPONSE_TOO_LARGE") return new Response(error.message, { status: 500 });
  if ((typeof code === "string" && inputCodes.has(code)) || (!code && !error.path)) return new Response("Invalid input", { status: 400 });
  return new Error(`${error.path?.join(".") ?? "document"}: ${error.message}`);
}

/** How an app's pages and routes run its own documents in process, over the schema and context the platform's
 * graph.graphql and graph.mutate use, with the largest response allowed (256 KiB): a page gets the whole answer
 * or fails, never a list cut to fit. Errors become what the route answers or throws (documentError). An app
 * binds it once: `export const runDocument = documentRunner<AppContext>(() => graphqlSchema)`; the schema is
 * read on each run, since the schema's own modules may import the app's documents. */
export function documentRunner<Context extends object>(schema: () => GraphQLSchema) {
  return async <Result, Variables extends Record<string, unknown>>(document: TadaDocumentNode<Result, Variables>, variables: Variables, context: Context): Promise<Result> => {
    const operation = getOperationAST(document);
    const result = await serveGraphql({
      schema: schema(), query: document.loc?.source.body ?? print(document), operationName: operation?.name?.value, variables, context: { ...(context as Record<string, unknown>) }, maxBytes: 262144,
      operation: operation?.operation === "mutation" ? "mutation" : "query",
    });
    if (result.errors?.[0]) throw documentError(result.errors[0]);
    if (result.extensions?.truncated) throw new Response("The response was too large to return whole", { status: 500 });
    return result.data as Result;
  };
}

const description = "GraphQL read over this app's records; read the schema with __schema or __type. Each collection takes first (default 100, at most 500), after and ids and returns nodes, pageInfo and aggregate { count }, in ID order. Depth 8 and 2000 fields at most; the whole response stays within maxBytes: lists are cut (extensions.truncated, truncatedPaths), never records, and a response that cannot fit returns RESPONSE_TOO_LARGE. Read only.";
/** The `graph.graphql` action over `schema`, for the app's actionAPI. Resolvers get the action's context. */
export function graphqlAction<Context extends ActionContext>(schema: GraphQLSchema) {
  return defineAction({
    description, access: "read", input: graphGraphqlInput, output: graphGraphqlResult,
    run: (context: Context, input) => serveGraphql({ schema, ...input, context }),
  });
}

const mutateDescription = "GraphQL mutation over this app's records: one mutation operation, from a document the app publishes. Each field validates its input and checks the caller's access itself.";
/** The `graph.mutate` action over `schema`, for the app's actionAPI: mutation operations only, as a write.
 * `canInvoke` replaces the default editor gate when a mutation's own check allows non-editors (a duty, say).
 * `external` admits members of other organizations (role `external`), who reach only fields marked `external`. */
export function mutateAction<Context extends ActionContext>(schema: GraphQLSchema, options: { canInvoke?: (context: Context) => boolean; external?: true } = {}) {
  if (!schema.getMutationType()) throw new Error("mutateAction needs a schema with a Mutation type");
  return defineAction({
    description: mutateDescription, access: "write", input: graphMutateInput, output: graphGraphqlResult, ...options,
    run: (context: Context, input) => serveGraphql({ schema, ...input, context, operation: "mutation" }),
  });
}

type JsonSchema = {
  type?: string | string[]; format?: string; enum?: unknown[]; const?: unknown; maximum?: number; minimum?: number;
  properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema; anyOf?: JsonSchema[]; $ref?: string;
};
const enumValue = /^[_a-zA-Z][_a-zA-Z0-9]*$/;
/** GraphQL forbids these as enum values; such an enum is a String that zod still checks. */
const reservedEnumValues = new Set(["true", "false", "null"]);
/** zod prints a nullable field as `type: [T, "null"]`, or `anyOf` with a null branch. */
const nullable = (schema: JsonSchema) => !!schema.anyOf?.some(option => option.type === "null") || (Array.isArray(schema.type) && schema.type.includes("null"));
const int32 = 2 ** 31 - 1;
function scalarType(schema: JsonSchema) {
  if (schema.type === "string") return schema.format === "uuid" ? GraphQLID : GraphQLString;
  if (schema.type === "boolean") return GraphQLBoolean;
  // GraphQL's Int is 32-bit; larger integers (revisions) travel as Float and zod checks they are whole.
  const int = schema.type === "integer" && (schema.maximum ?? Number.POSITIVE_INFINITY) <= int32 && (schema.minimum ?? Number.NEGATIVE_INFINITY) >= -int32 - 1;
  return int ? GraphQLInt : GraphQLFloat;
}
/** The GraphQL input type (nullable) for a JSON schema zod printed; `name` names the objects and enums it declares.
 * What GraphQL cannot type (unions, records, recursive JSON) is JSON, and zod still validates it. */
function inputType(schema: JsonSchema, name: string): GraphQLInputType {
  const options = schema.anyOf?.filter(option => option.type !== "null");
  if (options?.length === 1) return inputType(options[0], name);
  const types = Array.isArray(schema.type) ? schema.type.filter(type => type !== "null") : null;
  if (types?.length === 1) return inputType({ ...schema, type: types[0] }, name);
  if (schema.enum?.length && schema.enum.every(value => typeof value === "string" && enumValue.test(value) && !reservedEnumValues.has(value)))
    return new GraphQLEnumType({ name, values: Object.fromEntries((schema.enum as string[]).map(value => [value, { value }])) });
  switch (schema.type) {
    case "string": case "boolean": case "number": case "integer": return scalarType(schema);
    case "array": return new GraphQLList(new GraphQLNonNull(inputType(schema.items ?? {}, `${name}Item`)));
    case "object": {
      const properties = Object.entries(schema.properties ?? {});
      if (!properties.length) return JSONScalar;
      const required = new Set(schema.required ?? []);
      return new GraphQLInputObjectType({ name, fields: Object.fromEntries(properties.map(([key, property]) => {
        const type = inputType(property, `${name}${graphqlNames.typeName(key)}`);
        return [key, { type: required.has(key) && !nullable(property) ? new GraphQLNonNull(type) : type }];
      })) });
    }
    default: return JSONScalar;
  }
}

/** A Response a domain function throws (a refusal) becomes a GraphQL error carrying its status;
 * a query field that refuses rethrows through it, as mutationField does. */
export async function fieldError(error: unknown) {
  if (error instanceof Response) return new GraphQLError((await error.text()) || `Refused (${error.status})`, { extensions: { code: "REFUSED", status: error.status } });
  return error;
}
export type MutationFieldOptions<Input extends z.ZodType, Context> = {
  /** Names the GraphQL input type (`<name>Input`) and the types it declares. */
  name: string;
  description: string;
  input: Input;
  /** What the field returns; JSON when omitted. */
  output?: GraphQLOutputType;
  run: (context: Context, input: z.output<Input>) => unknown;
  /** A member of another organization (role `external`, `identity.callerOrganizationId`) may run it;
   * every other field refuses them. `run` decides whom it serves. */
  external?: true;
};
/** A Mutation field `(input: <Name>Input!)` whose GraphQL input type is derived from the zod schema the app
 * already validates with (an action's input, say), so typegen and agents see typed variables. The zod schema
 * still parses the input before `run`, which keeps the app's checks; a thrown Response becomes a REFUSED error. */
export function mutationField<Input extends z.ZodType, Context = TableContext & ActionContext>(options: MutationFieldOptions<Input, Context>): GraphQLFieldConfig<unknown, Context> {
  const json = z.toJSONSchema(options.input, { io: "input", unrepresentable: "any" }) as JsonSchema;
  return {
    type: options.output ?? JSONScalar, description: options.description,
    extensions: { batchInput: options.input },
    args: { input: { type: new GraphQLNonNull(inputType(json, `${options.name}Input`)) } },
    resolve: async (_source, args: { input: unknown }, context) => {
      const parsed = options.input.safeParse(args.input);
      if ((context as Partial<ActionContext>).identity?.role === "external" && !options.external)
        throw new GraphQLError("Not open to other organizations", { extensions: { code: "REFUSED", status: 403 } });
      if (!parsed.success) throw new GraphQLError(parsed.error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "), { extensions: { code: "BAD_USER_INPUT" } });
      try { return await options.run(context, parsed.data); }
      catch (error) { throw await fieldError(error); }
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: any async SQLite driver (D1 in apps, libSQL in tests)
type Database = BaseSQLiteDatabase<"async", any, any>;
export type TableContext = GraphContext & { db: () => Database };
type Key<T extends SQLiteTable> = keyof T["_"]["columns"] & string;
export type TableTypeOptions<T extends SQLiteTable> = {
  /** The root field and the GraphQL type of one row, e.g. `records` and `Record`. */
  field: string; type: string;
  /** The columns served, by their key in the table; the primary key is always served, as ID. */
  fields: Key<T>[];
  /** Number columns holding epoch milliseconds, served as DateTime (ISO-8601). */
  dates?: Key<T>[];
  /** Columns holding the IDs of other records (a foreign key such as `companyId`), served as ID. */
  ids?: Key<T>[];
  /** Columns a request may match against a list of values, as arguments named like the column. */
  filters?: Key<T>[];
  /** The rows this request may read, ANDed into every query of the table (for example the
   * caller's own rows, from `context.identity`). Returning undefined serves no rows. */
  scope?: (context: TableContext & ActionContext) => SQL | undefined;
};

const scalars: Record<string, GraphQLScalarType> = { string: GraphQLString, number: GraphQLFloat, boolean: GraphQLBoolean, date: DateTimeScalar };
const nonNull = <T extends GraphQLScalarType | GraphQLObjectType>(type: T) => new GraphQLNonNull(type);

// A collection tableType cannot express (a join, a computed field) is written by hand
// with these, so it takes the same arguments and pages and truncates the same way.
export { idList, page, type PageArgs, pageStart };
/** `first`, `after` and `ids`, the arguments every collection takes. */
export const pageArgs = (): GraphQLFieldConfigArgumentMap =>
  ({ first: { type: GraphQLInt, defaultValue: 100 }, after: { type: GraphQLString }, ids: { type: new GraphQLList(nonNull(GraphQLID)) } });
/** `<row>Connection { nodes pageInfo aggregate }`. */
export const connectionType = (row: GraphQLObjectType) => new GraphQLObjectType({
  name: `${row.name}Connection`,
  fields: { nodes: { type: new GraphQLNonNull(new GraphQLList(nonNull(row))) }, pageInfo: { type: nonNull(PageInfo) }, aggregate: { type: nonNull(Aggregate) } },
});

/** The root field `field(first, after, ids, ...filters)` over one table, returning
 * `<type>Connection { nodes pageInfo aggregate }` as a Wiki's collections do: ID-ordered
 * pages from the database, never the whole table. */
export function tableType<T extends SQLiteTable>(table: T, { field, type, fields, dates = [], ids = [], filters = [], scope }: TableTypeOptions<T>): GraphQLFieldConfigMap<unknown, TableContext> {
  const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
  const keys = Object.keys(columns).filter(key => columns[key].primary);
  if (keys.length !== 1) throw new Error(`${type} needs a table with one primary key column`);
  const [id] = keys;
  const served = [...new Set([id, ...fields])];
  const isId = (key: string) => key === id || ids.includes(key);
  const scalar = (key: string) => isId(key) ? GraphQLID : dates.includes(key) ? DateTimeScalar : scalars[columns[key].dataType] ?? JSONScalar;
  const row = new GraphQLObjectType({
    name: type,
    fields: Object.fromEntries(served.map(key => [key, { type: columns[key].notNull ? nonNull(scalar(key)) : scalar(key) }])),
  });
  const args: GraphQLFieldConfigArgumentMap = {
    ...pageArgs(),
    search: {type:GraphQLString,description:"Match text across this collection’s text fields."},
    ...Object.fromEntries(filters.map(key => [key, { type: new GraphQLList(nonNull(isId(key) ? GraphQLID : scalars[columns[key].dataType] ?? GraphQLString)) }])),
  };
  const selection = Object.fromEntries(served.map(key => [key, columns[key]]));
  return {
    [field]: {
      type: nonNull(connectionType(row)), args,
      resolve: async (_source, args: Record<string, unknown> & PageArgs, context, info) => {
        const { first, start } = pageStart(args);
        const visible = scope?.(context as TableContext & ActionContext);
        if (scope && !visible) return { ...page(context, info, [], String, first, start), aggregate: { count: 0 } };
        // At most 200 values per argument, as a Wiki's ids take.
        const matching = (column: SQLiteColumn, values: unknown) => {
          const list = idList(values as string[] | null | undefined);
          return list ? inArray(column, list) : undefined;
        };
        const search = typeof args.search === "string" ? args.search.trim() : "";
        if (search.length > 200) throw new GraphQLError("Search exceeds 200 characters");
        const textColumns = served.filter(key => columns[key].dataType === "string" && !isId(key));
        const where = and(visible, matching(columns[id], args.ids), search && textColumns.length ? or(...textColumns.map(key => like(columns[key], `%${search}%`))) : undefined, ...filters.map(key => matching(columns[key], args[key])));
        const db = context.db();
        const rows = await db.select(selection).from(table as SQLiteTable)
          .where(and(where, start === null ? undefined : gt(columns[id], start))).orderBy(asc(columns[id])).limit(first + 1);
        // Rows the response could not hold are cut before they resolve, as maxBytes cuts a list,
        // so a page of large rows comes back truncated; a first row too large still is refused.
        const kept = rowsWithinBudget(rows, first, context.budget.maxBytes - context.budget.bytes);
        if (kept < first) context.truncated.push([...responsePathAsArray(info.path), "nodes"]);
        return {
          ...page(context, info, rows, row => String(row[id]), kept, start),
          // Counted only when selected.
          aggregate: { count: async () => (await db.select({ count: count() }).from(table as SQLiteTable).where(where))[0].count },
        };
      },
    },
  };
}

function rowsWithinBudget(rows: unknown[], first: number, room: number): number {
  let fits = 0;
  for (const row of rows.slice(0, first)) {
    room -= JSON.stringify(row).length;
    if (room < 0) break;
    fits++;
  }
  return fits > 0 && fits < Math.min(first, rows.length) ? fits : first;
}

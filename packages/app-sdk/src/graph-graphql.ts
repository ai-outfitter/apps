// GraphQL over a Wiki knowledge graph. The schema is generated from the graph's
// type rows on every request, so a type added at runtime is queryable on the next
// one; nothing here names a domain concept. Reads only.
//
// Naming rules (graphqlNames):
// - Type name: PascalCase of the Wiki type name, non-alphanumerics removed
//   (`reports_to` → `ReportsTo`); a leading digit gets a `T` prefix.
// - fieldName: the type name with its first letter lowercased (`reportsTo`).
// - collectionName: fieldName + "s", unchanged when it already ends in "s".
// - Root fields per node type: `fieldName(id, slug)` (exactly one of them: a slug is a
//   node's address, unique across the Wiki's node types) and `collectionName(first, after,
//   archived, ids, slugs, text[, at])` returning `<Type>Connection { nodes pageInfo aggregate }`.
//   When the collection name equals fieldName, the singular is `fieldName + "ById"`.
//   Also `node(id, slug)` (any node type), cursor-paginated `searchConnection(text, types, first, after)`,
//   legacy capped `search(text, types, first)` and `sdl` (the schema
//   as SDL). By-key roots take `archived = EXCLUDE`, as graph.query matches.
// - Node fields: id typeId revision title summary slug body archived updatedAt properties
//   edges(types, direction, at, archived) validFrom validUntil (every node type: validity is a
//   row's, so a document written for the standard schema reads any Wiki); one typed scalar
//   per entry of the type's `properties` list, named as stored.
// - Edge type E with ontology.endpoints: on each `from` type `fieldName(E)` (targets) and
//   `fieldName(E)Edges` (edge objects); on each `to` type `fieldName(E)Incoming` and
//   `fieldName(E)IncomingEdges`. Args (at, archived). Edge types without endpoints get no
//   typed fields; read them through `edges(types:)`, which returns edge objects with from/to.
// - A projection edge type (ontology.projection) is a field `fieldName(E)` on the fromSlot's
//   participant types reaching the toSlot's participants through the relator (and
//   `fieldName(E)Incoming` the other way unless symmetric).
// - A field whose target may be one of several types returns the `Node` interface.
// - Edge object type `E`: id typeId revision title body fromId toId from to properties
//   archived updatedAt validFrom validUntil, plus one typed scalar per edge property.
// - Relator slots (stereotype "relator"): a field per slot name, one participant when
//   max is 1 else a list; participant types get `collectionName(relator)(as, first, after,
//   archived, at)`.
// - Names go to the oldest type first (createdAt, then ID); collisions append `_` + the last 8
//   alphanumerics of the type ID. Caller names (recordFields, rootExtensions/rootFieldNames,
//   typeNames) are reserved first. Reported in `extensions.naming` on schema-reading queries
//   (__schema, __type, sdl) and, one by one, on queries that use a renamed name.
//   Archived types are not in the schema.
// - A relator slot over an edge type replaces that edge's target field on the relator.
// Privacy and state follow graph.query: privateData, externalProvider and externalId never
// leave; archived records are excluded by default, and relationships also hide retired ones.
import { type DocumentNode, execute, getOperationAST, type GraphQLSchema, type GraphQLError, Kind, parse, type SelectionNode, validate, visit } from "graphql";
import { z } from "zod";
import { fitResponse, measureQuery, responseBytes } from "./graph-graphql-limits";
import type { NamingWarning, TypeRow } from "./graph-graphql-names";
import { cursorAfter, graphContext, responseTooLarge } from "./graph-graphql-resolve";
import { buildGraphSchema, type GraphSchemaOptions } from "./graph-graphql-schema";
import { type GraphSource, memorySource } from "./graph-graphql-source";

export { graphqlNames, type NamingWarning, type TypeRow } from "./graph-graphql-names";
export { type ArchivedFilter, compareIds, type EdgeQuery, type EdgeRow, type GraphRow, type GraphSource, matchesSourceAndProperties, memorySource, type NodeQuery, type PropertyFilter, sourceKey, type SourceRef } from "./graph-graphql-source";
export { type GraphContext, graphContext } from "./graph-graphql-resolve";
export { buildGraphSchema, type GraphSchemaOptions, type KeyArgs } from "./graph-graphql-schema";
export { ArchivedEnum, DateTimeScalar, DirectionEnum, JSONScalar } from "./graph-graphql-scalars";
export { definitionFromResult, queryHash, resultRecords, selectFromResult, type SelectionDocument, selectionDocument, selectionQueryDepth, selectionVariables } from "./graph-graphql-selection";

export { graphGraphqlAction, graphGraphqlInput, graphGraphqlResult, type GraphGraphqlInput, type GraphGraphqlResult, type GraphGraphqlError } from "./graph-protocol";
import { graphGraphqlInput, type GraphGraphqlResult, type GraphGraphqlError } from "./graph-protocol";

const maxErrors = 20;
/** Platform dispatch reads at most 512 KiB; a schema-only request may use up to this much. */
const introspectionBytes = 448 * 1024;
/** Room kept for extensions.truncatedPaths (at most 20 paths). */
const truncationReserve = 2048;
const schemaFields = new Set(["__schema", "__type", "__typename", "sdl"]);
/** Root selections of the operation that runs. */
const rootSelections = (document: DocumentNode, operationName?: string) => document.definitions.flatMap(definition =>
  definition.kind === Kind.OPERATION_DEFINITION && (!operationName || definition.name?.value === operationName) ? definition.selectionSet.selections : []);
const readsSchema = (selection: SelectionNode) => selection.kind === Kind.FIELD && schemaFields.has(selection.name.value) && selection.name.value !== "__typename";
const shape = (error: GraphQLError): GraphGraphqlError => ({
  message: error.message,
  ...(error.path ? { path: [...error.path] } : {}),
  ...(error.extensions && Object.keys(error.extensions).length ? { extensions: JSON.parse(JSON.stringify(error.extensions)) } : {}),
});
const failure = (message: string, code: string): GraphGraphqlResult => ({ data: null, errors: [{ message, extensions: { code } }] });

export type ExecuteGraphQueryArgs = {
  query: string; variables?: Record<string, unknown>; operationName?: string; maxBytes: number;
  maxDepth?: number; maxFields?: number;
  /** The only operation kind this request may run (default query): graph.graphql reads, graph.mutate writes. */
  operation?: "query" | "mutation";
  /** Merged into the resolver context, for root extensions. */
  context?: Record<string, unknown>;
  /** Merged into the result's extensions; a `naming` array is appended to the schema's warnings. */
  extensions?: Record<string, unknown>;
} & (
  /** A Wiki's types and records; `schema` is one already built from `types` (for callers that cache it). */
  | { types: TypeRow[]; source: GraphSource; schema?: GraphQLSchema; schemaOptions?: GraphSchemaOptions }
  /** A schema whose resolvers read their own records (an app's tables, app-graphql.ts). */
  | { schema: GraphQLSchema; types?: undefined; source?: undefined; schemaOptions?: undefined }
);
/** The loader of a schema that reads no Wiki records. */
const noRecords = memorySource({ installationId: "", types: [], nodes: [], edges: [] });
const sourceOf = (args: ExecuteGraphQueryArgs) => args.source ?? noRecords;
const schemaOf = (args: ExecuteGraphQueryArgs) => args.schema ?? buildGraphSchema(args.types ?? [], args.schemaOptions);

/** Field and type names the document uses. */
function namesUsed(document: DocumentNode) {
  const names = new Set<string>();
  visit(document, { Field: node => { names.add(node.name.value); }, NamedType: node => { names.add(node.name.value); } });
  return names;
}
/** The caller's extensions, plus naming warnings: all of them when the query reads the schema, else those for names
 * the query uses (a renamed field or type); naming lists concatenate. A plain data query carries none. */
function baseExtensions(schema: GraphQLSchema, document: DocumentNode, introspects: boolean, extra: Record<string, unknown> = {}) {
  const warnings = (schema.extensions as { naming?: NamingWarning[] }).naming ?? [];
  const used = introspects || !warnings.length ? null : namesUsed(document);
  const own = introspects ? warnings : warnings.filter(warning => warning.graphqlName && used?.has(warning.graphqlName));
  const naming = [...own, ...(Array.isArray(extra.naming) ? extra.naming : [])];
  return JSON.parse(JSON.stringify({ ...extra, ...(naming.length ? { naming } : {}) })) as Record<string, z.infer<ReturnType<typeof z.json>>>;
}
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/** A refusal when the operation that would run is not the request's kind (graph.graphql reads, graph.mutate writes). */
function wrongOperation(document: DocumentNode, { operationName, operation = "query" }: ExecuteGraphQueryArgs) {
  const kind = getOperationAST(document, operationName)?.operation;
  return kind === operation ? null : failure(kind ? `This request runs ${operation} operations, not ${kind}` : "Name the operation to run", "OPERATION_NOT_ALLOWED");
}

/** Parse, validate, bound and run one GraphQL request over a GraphSource, or over a
 * schema with its own resolvers (whose fields meterFields must count). The whole
 * response, extensions included, stays within maxBytes (introspection: 448 KiB). */
export async function executeGraphQuery(args: ExecuteGraphQueryArgs): Promise<GraphGraphqlResult> {
  const { maxDepth = 8, maxFields = 2000 } = args;
  let schema: GraphQLSchema;
  try { schema = schemaOf(args); }
  catch (error) { return failure(`The schema could not be built: ${message(error, "unknown error")}`, "SCHEMA_BUILD_FAILED"); }
  let document: DocumentNode;
  try { document = parse(args.query, { maxTokens: 10_000 }); }
  catch (error) { return failure(message(error, "Invalid query"), "GRAPHQL_PARSE_FAILED"); }
  const invalid = validate(schema, document);
  if (invalid.length) return { data: null, errors: invalid.slice(0, maxErrors).map(error => ({ ...shape(error), extensions: { code: "GRAPHQL_VALIDATION_FAILED" } })) };
  const refused = wrongOperation(document, args);
  if (refused) return refused;
  const measured = measureQuery(document, args.operationName, maxFields + 1);
  if (measured.depth > maxDepth) return failure(`Query depth ${measured.depth > 1000 ? "is too deep" : measured.depth} exceeds the limit of ${maxDepth}`, "QUERY_TOO_DEEP");
  if (measured.fields > maxFields) return failure(`Query selects more than ${maxFields} fields`, "QUERY_TOO_COMPLEX");
  const roots = rootSelections(document, args.operationName);
  // Introspection grows with the Wiki's types, not its records, so it gets the dispatch budget.
  const budget = roots.every(selection => selection.kind === Kind.FIELD && schemaFields.has(selection.name.value)) ? Math.max(args.maxBytes, introspectionBytes) : args.maxBytes;
  const context = graphContext(sourceOf(args), args.context, { maxBytes: 4 * budget });
  const result = await execute({ schema, document, variableValues: args.variables, operationName: args.operationName, contextValue: context });
  // A mutation has already written: its refusal must not read as a failed write.
  const tooLarge = () => failure(`${responseTooLarge().message}${args.operation === "mutation" ? " The mutation ran; read the result back instead of retrying." : ""}`, "RESPONSE_TOO_LARGE");
  if (context.budget.exceeded) return tooLarge();
  const response: GraphGraphqlResult = { data: (result.data ?? null) as GraphGraphqlResult["data"] };
  if (result.errors?.length) response.errors = result.errors.slice(0, maxErrors).map(shape);
  const extensions = baseExtensions(schema, document, roots.some(readsSchema), args.extensions);
  const cut = fitResponse(response, budget - responseBytes(extensions) - truncationReserve, (path, kept) => cursorAfter(context, path, kept));
  // A list cut while resolving may be cut again here; it is named once.
  const paths = [...new Map([...context.truncated, ...cut].map(path => [JSON.stringify(path), path])).values()].slice(0, 20);
  if (paths.length) Object.assign(extensions, { truncated: true, truncatedPaths: paths });
  if (Object.keys(extensions).length) response.extensions = extensions;
  return responseBytes(response) > budget ? tooLarge() : response;
}

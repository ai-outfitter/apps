// Internal GraphQL documents and the app's explicitly curated MCP subset share
// validation and execution. Publication metadata changes discovery and the MCP
// representation only; pages retain their original typed GraphQL documents.
import { type DocumentNode, getOperationAST, type GraphQLError, type GraphQLSchema, Kind, type OperationDefinitionNode, parse, print, type TypeNode, validate } from "graphql";
import { documentOutputSchema } from "./document-output";
import { documentFederation, type DocumentFederation } from "./document-federation";
export type { DocumentFederation } from "./document-federation";
import { queryHash } from "./graph-graphql-selection";

/** One document and the user story that justifies it: "As a <who>, I want <what>, so that <why>." */
export type McpPublication = { description: string; collection?: true; organizationFilter?: string; provenance?: "organizationSlug"; markdown?: { title: string; slug?: string } };
export type AppDocument = { scheduleSource?: true; mcp?: McpPublication; story: string; document: DocumentNode | string; hidden?: boolean; publicName?: string; inputSchema?: Record<string, unknown> };
/** What the platform lists and runs: graph/documents.json holds one row per document. */
export type AppDocumentRow = {
  name: string; kind: "query" | "mutation"; story: string; query: string;
  /** Internal persisted-query hash. Public MCP calls use document names. */
  hash: string;
  variables: VariablesSchema;
  hidden?: boolean;
  scheduleSource?: true;
  mcp?: McpPublication;
  outputSchema?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  federation?: DocumentFederation;
};
export type VariablesSchema = { type: "object"; properties: Record<string, { type?: string; description: string }>; required: string[] };

const story = /^As an? .+, I want .+, so that .+/is;
/** Internal documents are executable but not published to MCP unless explicitly selected. */
export const defineDocuments = <T extends Record<string, AppDocument>>(documents: T) => documents;

/** App-owned publication decisions; helpers and UI documents remain executable unchanged. */
export function publishDocuments<T extends Record<string, AppDocument>>(documents: T, publications: Record<string, McpPublication>): T {
  for (const [name, publication] of Object.entries(publications)) {
    if (!documents[name]) throw new Error(`Cannot publish missing document ${name}`);
    if (!publication.description.trim()) throw new Error(`MCP document ${name} needs a concise description`);
  }
  return Object.fromEntries(Object.entries(documents).map(([name, entry]) => [name,
    publications[name] ? {...entry, hidden: false, mcp: publications[name]} : entry,
  ])) as T;
}


const jsonTypes: Record<string, string> = { Int: "integer", Float: "number", String: "string", ID: "string", Boolean: "boolean" };
const baseName = (type: TypeNode): string => (type.kind === Kind.NAMED_TYPE ? type.name.value : baseName(type.type));
const isList = (type: TypeNode) => type.kind === Kind.LIST_TYPE || (type.kind === Kind.NON_NULL_TYPE && type.type.kind === Kind.LIST_TYPE);

/** The variables an operation takes, as a JSON schema (GraphQL type names in descriptions). */
export function variablesSchema(operation: OperationDefinitionNode): VariablesSchema {
  const definitions = operation.variableDefinitions ?? [];
  return {
    type: "object",
    properties: Object.fromEntries(definitions.map(definition => {
      const json = isList(definition.type) ? "array" : jsonTypes[baseName(definition.type)];
      return [definition.variable.name.value, { ...(json ? { type: json } : {}), description: `GraphQL ${print(definition.type)}` }];
    })),
    required: definitions.filter(definition => definition.type.kind === Kind.NON_NULL_TYPE && !definition.defaultValue).map(definition => definition.variable.name.value),
  };
}

/** Every document as a manifest row, checked against `schema`: one operation named as its key, a user story,
 * and valid. Throws naming every document that fails, so a build reports them all at once. */
export function documentRows(schema: GraphQLSchema, documents: Record<string, AppDocument>): AppDocumentRow[] {
  const problems: string[] = [];
  const rows = Object.entries(documents).flatMap(([name, entry]): AppDocumentRow[] => {
    const node = typeof entry.document === "string" ? parse(entry.document) : entry.document;
    const operation = getOperationAST(node);
    const fail = (why: string) => { problems.push(`${name}: ${why}`); return []; };
    if (!story.test(entry.story.trim())) return fail('story must read "As a <who>, I want <what>, so that <why>."');
    if (!operation || node.definitions.filter(definition => definition.kind === Kind.OPERATION_DEFINITION).length !== 1) return fail("hold exactly one operation");
    if (operation.operation === "subscription") return fail("subscriptions are not served");
    if (operation.name?.value !== name) return fail(`the operation must be named ${name}`);
    const invalid = validate(schema, node);
    if (invalid.length) return fail(invalid.map((error: GraphQLError) => error.message).join("; "));
    const query = print(node);
    return [{...documentRow(name, entry, operation, query), ...publicationMetadata(schema, name, entry, operation)}];
  });
  if (problems.length) throw new Error(`Invalid app documents:\n${problems.join("\n")}`);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function documentRow(name: string, entry: AppDocument, operation: NonNullable<ReturnType<typeof getOperationAST>>, query: string): AppDocumentRow {
  return { ...(entry.scheduleSource ? {scheduleSource:true as const} : {}), name, kind: operation.operation as "query" | "mutation", story: entry.story.trim().replace(/\s+/g, " "), query, hash: queryHash(query), variables: variablesSchema(operation), ...(!entry.mcp || entry.hidden ? { hidden: true } : {}), ...(entry.mcp ? {mcp: entry.mcp} : {}), ...(entry.inputSchema ? { inputSchema: entry.inputSchema } : {}) };
}

function publicationMetadata(schema: GraphQLSchema, name: string, entry: AppDocument, operation: OperationDefinitionNode) {
  if (!entry.mcp) return {};
  const connection = entry.mcp.collection ? documentFederation(schema, operation) : undefined;
  const federation = connection && {...connection,...(entry.mcp.organizationFilter ? {organizationFilter:entry.mcp.organizationFilter} : {}),...(entry.mcp.markdown ? {markdown:entry.mcp.markdown} : {}),...(entry.mcp.provenance ? {provenance:entry.mcp.provenance} : {})};
  if (entry.mcp.collection && !federation) throw new Error(`${name}: published collection must select one first/after connection with nodes and pageInfo`);
  return {...(federation ? {federation} : {}),outputSchema:documentOutputSchema(schema, operation)};
}

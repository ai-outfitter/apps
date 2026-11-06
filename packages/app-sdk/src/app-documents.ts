// An app's documents: the named GraphQL queries and mutations its pages and agents
// run, each beside the user story it serves. The app's pages import the same typed
// (gql.tada) documents the platform lists to agents (graph_documents) and runs by name
// (graph_graphql, graph_mutate), so the UI and MCP never drift. scripts/graph-schema.ts
// writes them, checked against the app's schema, to graph/documents.json.
import { type DocumentNode, getOperationAST, type GraphQLError, type GraphQLSchema, Kind, type OperationDefinitionNode, parse, print, type TypeNode, validate } from "graphql";
import { queryHash } from "./graph-graphql-selection";

/** One document and the user story that justifies it: "As a <who>, I want <what>, so that <why>." */
export type AppDocument = { story: string; document: DocumentNode | string };
/** What the platform lists and runs: graph/documents.json holds one row per document. */
export type AppDocumentRow = {
  name: string; kind: "query" | "mutation"; story: string; query: string;
  /** sha256 hex of `query`; graph_graphql and graph_mutate take it or the name. */
  hash: string;
  variables: VariablesSchema;
};
export type VariablesSchema = { type: "object"; properties: Record<string, { type?: string; description: string }>; required: string[] };

const story = /^As an? .+, I want .+, so that .+/is;
/** Documents keyed by their operation name; a document a page or agent no longer needs is deleted, not kept. */
export const defineDocuments = <T extends Record<string, AppDocument>>(documents: T) => documents;

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
    return [{ name, kind: operation.operation, story: entry.story.trim().replace(/\s+/g, " "), query, hash: queryHash(query), variables: variablesSchema(operation) }];
  });
  if (problems.length) throw new Error(`Invalid app documents:\n${problems.join("\n")}`);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

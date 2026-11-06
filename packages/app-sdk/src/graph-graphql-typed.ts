// Typed GraphQL documents for graph.graphql. `graphql` is gql.tada's tagged
// function over the standard schema (the Wiki's seed types, committed under
// ../graph by catalog/apps/wiki-map/scripts/graph-schema.ts): a document's result
// and variable types are inferred from its text, with no generated code per
// query. An app whose Wiki also has its own seed types builds its own `graphql`
// with initGraphQLTada over an introspection written by writeGraphTypes.
import { initGraphQLTada, type TadaDocumentNode } from "gql.tada";
import { print } from "graphql";
import type { introspection } from "../graph/standard-env";

/** How graph.graphql serializes its custom scalars. */
export type GraphScalars = { DateTime: string; JSON: unknown };
export const graphql = initGraphQLTada<{ introspection: introspection; scalars: GraphScalars }>();
export type { FragmentOf, ResultOf, TadaDocumentNode, VariablesOf } from "gql.tada";
export { initGraphQLTada };

/** The query text to send as graph.graphql's `query`. */
// biome-ignore lint/suspicious/noExplicitAny: any document, whatever its result and variables
export const documentText = (document: TadaDocumentNode<any, any>) => document.loc?.source.body ?? print(document);

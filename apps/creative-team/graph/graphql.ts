import { type GraphScalars, initGraphQLTada } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import type { introspection } from "./graphql-env";

/** gql.tada over the schema this app serves (scripts/graph-schema.ts). */
export const graphql = initGraphQLTada<{ introspection: introspection; scalars: GraphScalars }>();

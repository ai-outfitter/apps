import { buildGraphSchema, type GraphContext, type GraphSchemaOptions, type TypeRow } from "@ai-outfitter/app-sdk/graph-graphql";
import { executeGraphQuery, type GraphGraphqlInput, graphGraphqlInput } from "@ai-outfitter/app-sdk/graph-graphql";
import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { type AppIdentity, sha256Hex } from "@ai-outfitter/app-sdk/server";
import type { GraphQLFieldConfigMap, GraphQLSchema } from "graphql";
import { databaseSource } from "./graph-source";
import { changeQueries, externalSchema } from "./graphql";
import { passageGraphTypeNames, type PassageGraphContext } from "./passage-graphql";
import { graphql } from "graphql";

const schemaOptions: GraphSchemaOptions = { rootExtensions: changeQueries as GraphQLFieldConfigMap<unknown, GraphContext>,
  typeNames: ["ChangeBatch", "StagedChange", "Exploration", "ExplorationSummary", "ExplorationPicture", "ExplorationNode", "ExplorationEdge", "ExplorationStepResult", "Share", "ShareView", "ShareNode", "ShareEdge", ...passageGraphTypeNames] };
/** The schemas last built, by the hash of the type rows each was generated from (nothing else decides a schema), most recently used last. */
const schemas = new Map<string, GraphQLSchema>();
const maxSchemas = 8;
/** The schema of these type rows: built once, then reused until a type changes. A Worker keeps the few Wikis it served last. */
export async function graphSchema(types: TypeRow[]) {
  const key = await sha256Hex(JSON.stringify(types));
  const schema = schemas.get(key) ?? buildGraphSchema(types, schemaOptions);
  schemas.delete(key);
  schemas.set(key, schema);
  if (schemas.size > maxSchemas) schemas.delete(schemas.keys().next().value as string);
  return schema;
}

/** GraphQL over the same records `graph.query` reads (nodeView already drops private
 * fields), through indexed reads of this Wiki's tables; the schema is generated from
 * its types (graphSchema), so a type added at runtime is queryable on the next call.
 * Change batches (changeQueries) answer beside them, as the Wiki's printed schema promises the platform. */
export async function graphqlGraphRecords(db: ReturnType<typeof installationDatabase>, identity: AppIdentity, raw: GraphGraphqlInput, context: Omit<PassageGraphContext, "identity"> = {}) {
  const input = graphGraphqlInput.parse(raw);
  // A member of another organization reads only the shares made for it (graph-shares.ts).
  if (identity.role === "external") {
    const result = await graphql({ schema: externalSchema, source: input.query, variableValues: input.variables, operationName: input.operationName, contextValue: { db: () => db, identity } });
    return { data: (result.data ?? null) as Record<string, unknown> | null, ...(result.errors?.length ? { errors: result.errors.map(error => ({ message: error.message, ...(error.path ? { path: [...error.path] } : {}) })) } : {}) };
  }
  const source = databaseSource(db), types = await source.types();
  return executeGraphQuery({
    // A schema that cannot be built is built again by executeGraphQuery, which answers SCHEMA_BUILD_FAILED.
    types, source, schema: await graphSchema(types).catch(() => undefined), schemaOptions,
    context: { ...context, db: () => db, identity },
    query: input.query, variables: input.variables, operationName: input.operationName, maxBytes: input.maxBytes,
  });
}

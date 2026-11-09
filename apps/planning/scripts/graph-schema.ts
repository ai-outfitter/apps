// Writes the GraphQL schema this app serves over graph.graphql and graph.mutate, gql.tada's
// type file for it, and the documents its pages and agents run (graph/documents.json), all
// under graph/. `--check` fails instead when a committed file is stale.
import { resolve } from "node:path";
import { exitIfStale, writeAppDocuments, writeSchemaTypes } from "@ai-outfitter/app-sdk/graph-graphql-typegen";
import { documents } from "../src/server/documents";
import { graphqlSchema } from "../src/server/graphql";

export async function graphSchema({ check = false } = {}) {
  const tsconfig = resolve(import.meta.dirname, "../tsconfig.json");
  return (await Promise.all([writeSchemaTypes(graphqlSchema, tsconfig, { check }), writeAppDocuments(graphqlSchema, documents, tsconfig, { check })])).flat();
}

if (import.meta.main) exitIfStale(await graphSchema({ check: process.argv.includes("--check") }), "apps/planning/scripts/graph-schema.ts");

// Writes the standard GraphQL schema (the one every Wiki serves from its seed
// types) into the SDK: the type rows apps compose with their own seeds, the SDL,
// and gql.tada's type file. And the Wiki's own: the change-batch schema agents run
// documents over (graph/schema.graphql) and those documents (graph/documents.json).
// `--check` fails instead when a committed file is stale.
import { resolve } from "node:path";
import type { TypeRow } from "@ai-outfitter/app-sdk/graph-graphql";
import { exitIfStale, graphTypeRows, syncFile, writeAppDocuments, writeGraphTypes } from "@ai-outfitter/app-sdk/graph-graphql-typegen";
import { printSchema } from "graphql";
import { defaultTypes } from "../src/lib/default-types";
import { documents } from "../src/server/documents";
import { graphqlSchema } from "../src/server/graphql";

const sdk = resolve(import.meta.dirname, "../../../packages/app-sdk");
const rowsPath = resolve(sdk, "graph/standard-types.json");
const app = resolve(import.meta.dirname, "..");

export async function standardGraphTypes({ check = false } = {}) {
  const rows = graphTypeRows(defaultTypes as unknown as TypeRow[]);
  const stale = (await syncFile(rowsPath, `${JSON.stringify(rows, null, 1)}\n`, check)) ? [rowsPath] : [];
  return [...stale, ...(await writeGraphTypes(rows, resolve(sdk, "tsconfig.json"), { check }))];
}

export async function wikiGraphSchema({ check = false } = {}) {
  const sdl = resolve(app, "graph/schema.graphql");
  const stale = (await syncFile(sdl, `${printSchema(graphqlSchema)}\n`, check)) ? [sdl] : [];
  return [...stale, ...(await writeAppDocuments(graphqlSchema, documents, resolve(app, "tsconfig.json"), { check }))];
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  exitIfStale([...(await standardGraphTypes({ check })), ...(await wikiGraphSchema({ check }))], "apps/onto/scripts/graph-schema.ts");
}

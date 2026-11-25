// Writes Onto's GraphQL schema and published documents. The shared standard
// schema is composed from app-owned sources by scripts/compose-graphs.ts.
import { resolve } from "node:path";
import { exitIfStale, syncFile, writeAppDocuments } from "@ai-outfitter/app-sdk/graph-graphql-typegen";
import { printSchema } from "graphql";
import { documents } from "../src/server/documents";
import { graphqlSchema } from "../src/server/graphql";

const app = resolve(import.meta.dirname, "..");

export async function wikiGraphSchema({ check = false } = {}) {
  const sdl = resolve(app, "graph/schema.graphql");
  const stale = (await syncFile(sdl, `${printSchema(graphqlSchema)}\n`, check)) ? [sdl] : [];
  return [...stale, ...(await writeAppDocuments(graphqlSchema, documents, resolve(app, "tsconfig.json"), { check }))];
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  exitIfStale(await wikiGraphSchema({ check }), "apps/onto/scripts/graph-schema.ts");
}

import { resolve } from "node:path";
import { printSchema } from "graphql";
import {
  syncFile,
  writeAppDocuments,
  exitIfStale,
} from "@ai-outfitter/app-sdk/graph-graphql-typegen";
import { graphqlSchema, documents } from "../src/server/graphql";
const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const stale = await syncFile(
  resolve(root, "graph/schema.graphql"),
  printSchema(graphqlSchema) + "\n",
  check,
);
exitIfStale(
  [
    ...(stale ? [root + "/graph/schema.graphql"] : []),
    ...(await writeAppDocuments(
      graphqlSchema,
      documents,
      resolve(root, "tsconfig.json"),
      { check },
    )),
  ],
  "scripts/graph-schema.ts",
);

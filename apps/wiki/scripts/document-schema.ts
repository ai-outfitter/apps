import { resolve } from "node:path";
import { exitIfStale,writeAppDocuments,writeSchemaTypes } from "@ai-outfitter/app-sdk/graph-graphql-typegen";
import { graphqlSchema } from "../src/documents/graphql";
import { documents } from "../src/documents/documents";
const tsconfig=resolve(import.meta.dirname,"../tsconfig.json");
const check=process.argv.includes("--check");
exitIfStale((await Promise.all([writeSchemaTypes(graphqlSchema,tsconfig,{check}),writeAppDocuments(graphqlSchema,documents,tsconfig,{check})])).flat(),"scripts/document-schema.ts");

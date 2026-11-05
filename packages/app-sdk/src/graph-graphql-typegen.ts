// Build time only (node:fs, @gql.tada/internal): never import from app runtime code.
// Writes the GraphQL schema a Wiki generates from a set of type rows (or one an app
// builds) as SDL, and gql.tada's introspection type file for it, so `graphql()`
// documents written against that schema get result and variable types. The tsconfig named here
// carries the gql.tada plugin entry: a named entry under `schemas` with `schema`
// and `tadaOutputLocation` (the only one, or the one `schema` names). A named schema writes no global `setupSchema`
// declaration, so the standard and an app's schema coexist, and the editor
// plugin writes the same file this does.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadFromSDL, minifyIntrospection, outputIntrospectionFile } from "@gql.tada/internal";
import { type GraphQLSchema, printSchema } from "graphql";
import { type AppDocument, documentRows } from "./app-documents";
import type { TypeRow } from "./graph-graphql-names";
import { buildGraphSchema } from "./graph-graphql-schema";

type Entry = { name?: string; schema?: string; tadaOutputLocation?: string };
type Plugin = { name?: string; schemas?: Entry[] };
async function pluginSchema(tsconfig: string, name?: string) {
  const config = JSON.parse(await readFile(tsconfig, "utf8")) as { compilerOptions?: { plugins?: Plugin[] } };
  const entries = (config.compilerOptions?.plugins?.find((plugin) => plugin.name === "gql.tada/ts-plugin")?.schemas ?? [])
    .filter((entry) => !name || entry.name === name);
  const [entry] = entries;
  if (entries.length !== 1 || !entry.name || !entry.schema || !entry.tadaOutputLocation)
    throw new Error(`${tsconfig} needs one gql.tada/ts-plugin "schemas" entry${name ? ` named ${name}` : ""} with name, schema and tadaOutputLocation`);
  return { name: entry.name, schema: resolve(dirname(tsconfig), entry.schema), output: resolve(dirname(tsconfig), entry.tadaOutputLocation) };
}

/** Write `text` to `path`; with `check` write nothing and answer whether the file is stale. */
export async function syncFile(path: string, text: string, check: boolean) {
  const stale = (await readFile(path, "utf8").catch(() => "")) !== text;
  if (stale && !check) await writeFile(path, text);
  return check && stale;
}

/** The schema a Wiki with exactly these type rows serves from graph.graphql, as SDL. */
export const graphSchemaSdl = (types: TypeRow[]) => `${printSchema(buildGraphSchema(types))}\n`;

/** `schema` names the plugin entry when the tsconfig has more than one. */
type Options = { check?: boolean; schema?: string };
/** Write the SDL and the gql.tada type file the tsconfig names, or with `check`
 * write nothing and answer the files that are stale. */
export const writeGraphTypes = (types: TypeRow[], tsconfig: string, options: Options = {}) =>
  writeSdlTypes(graphSchemaSdl(types), tsconfig, options);

/** writeGraphTypes for a schema an app builds itself (app-graphql.ts). */
export const writeSchemaTypes = (schema: GraphQLSchema, tsconfig: string, options: Options = {}) =>
  writeSdlTypes(`${printSchema(schema)}\n`, tsconfig, options);

/** Write an app's documents, checked against `schema`, as graph/documents.json beside its tsconfig
 * (app-documents.ts), or with `check` answer whether that file is stale. */
export async function writeAppDocuments(schema: GraphQLSchema, documents: Record<string, AppDocument>, tsconfig: string, { check = false }: { check?: boolean } = {}) {
  const path = resolve(dirname(resolve(tsconfig)), "graph/documents.json");
  return (await syncFile(path, `${JSON.stringify(documentRows(schema, documents), null, 2)}\n`, check)) ? [path] : [];
}

async function writeSdlTypes(sdl: string, tsconfig: string, { check = false, schema }: Options) {
  const paths = await pluginSchema(resolve(tsconfig), schema);
  // A stale SDL makes the type file stale too; checking stops there.
  if (await syncFile(paths.schema, sdl, check)) return [paths.schema];
  const { introspection } = await loadFromSDL({ file: paths.schema, name: paths.name, assumeValid: true }).load();
  const output = outputIntrospectionFile(minifyIntrospection(introspection), { fileType: paths.output, shouldPreprocess: true });
  return (await syncFile(paths.output, output, check)) ? [paths.output] : [];
}

/** Only what the schema builder reads from a type row, for committing alongside the SDL. */
export const graphTypeRows = (types: TypeRow[]): TypeRow[] => types.map(({ id, category, name, title, archived, createdAt, properties, ontology }) =>
  JSON.parse(JSON.stringify({ id, category, name, title, archived, createdAt, properties, ontology })));

/** A graph-schema script's exit: list the stale files and fail. */
export function exitIfStale(stale: string[], script: string) {
  if (!stale.length) return;
  console.error(`Stale, run node --import tsx ${script}:\n${stale.join("\n")}`);
  process.exit(1);
}

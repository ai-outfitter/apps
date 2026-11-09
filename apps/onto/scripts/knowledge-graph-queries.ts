// Writes each seed KnowledgeGraph's compiled GraphQL document into its JSON body
// (`query`, its sha256 `hash` and the `variables` schema), compiled over the standard seed types. `--check` fails instead when a
// committed query is stale.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TypeRow } from "@ai-outfitter/app-sdk/graph-graphql";
import { knowledgeGraphTypeId } from "@ai-outfitter/app-sdk/graph-selection";
import { nodeBodyLimit } from "@ai-outfitter/onto/contracts";
import { wikiGraphRecords } from "@ai-outfitter/app-sdk/graph-records";
import { defaultTypes } from "../src/lib/default-types";
import { compiledQuery } from "../src/lib/knowledge-graph-document";

/** nodeInput's body limit: a seed past it would fail every Wiki's setup. */
export { nodeBodyLimit };
const seedPaths = ["knowledge-graphs-v1.json", "releases-v1.json"].map((file) => resolve(import.meta.dirname, "../seeds", file));
type SeedNode = { id: string; typeId: string; title: string; body: string; archived?: boolean };

/** The seed files with every active JSON-body KnowledgeGraph's `query` brought up to date. */
export async function seedQueries() {
  const files = await Promise.all(seedPaths.map(seedFile));
  return { stale: files.some((file) => file.stale), write: () => Promise.all(files.map((file) => file.write())) };
}

async function seedFile(seedPath: string) {
  const before = await readFile(seedPath, "utf8");
  const seed = JSON.parse(before) as { nodes: SeedNode[] };
  const types = defaultTypes as unknown as TypeRow[];
  for (const node of seed.nodes) {
    if (node.typeId !== knowledgeGraphTypeId || node.archived || !node.body.trim().startsWith("{")) continue;
    const record = wikiGraphRecords({ installationId: "seed", types: [], nodes: [{ revision: 1, ...node } as never], edges: [] }, true).nodes[0];
    const { query: _query, hash: _hash, variables: _variables, ...body } = JSON.parse(node.body) as Record<string, unknown>;
    const compiled = compiledQuery(record, types);
    if (compiled) node.body = JSON.stringify({ ...body, ...compiled });
    if (node.body.length > nodeBodyLimit)
      throw new Error(`${node.title}: the body with its compiled query is ${node.body.length} characters, over the ${nodeBodyLimit}-character node body limit; narrow the selection`);
  }
  const after = `${JSON.stringify(seed, null, 2)}\n`;
  return { stale: after !== before, write: () => writeFile(seedPath, after) };
}

if (import.meta.main) {
  const { stale, write } = await seedQueries();
  if (stale && process.argv.includes("--check")) {
    console.error(`Stale, run node --import tsx apps/onto/scripts/knowledge-graph-queries.ts:\n${seedPaths.join("\n")}`);
    process.exit(1);
  }
  if (stale) await write();
}

import { access, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileAuthoredGraphs, type GraphContribution } from "@ai-outfitter/app-sdk/graph-authoring";
import { exitIfStale, graphTypeRows, syncFile, writeGraphTypes } from "@ai-outfitter/app-sdk/graph-graphql-typegen";

const root = resolve(import.meta.dirname, "..");
const apps = join(root, "apps");
const sdk = join(root, "packages/app-sdk");

type Contribution = GraphContribution & { namespace: string };
async function loadContributions() {
  const contributions: Contribution[] = [];
  for (const namespace of (await readdir(apps)).sort()) {
    const source = join(apps, namespace, "graph/definitions.ts");
    try { await access(source); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const module: { default: GraphContribution[] } = await import(pathToFileURL(source).href);
    const names = new Set<string>();
    for (const graph of module.default) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(graph.name) || names.has(graph.name))
        throw Error(`Invalid or duplicate graph contribution: ${namespace}/${graph.name}`);
      names.add(graph.name);
      contributions.push({ ...graph, namespace });
    }
  }
  return contributions;
}

export async function composeGraphs({ check = false } = {}) {
  const contributions = await loadContributions();
  const combined = contributions.filter(graph => !graph.isolated && !graph.legacyAlternatives);
  const standard = contributions.filter(graph => graph.scope === "standard");
  const variants = contributions.filter(graph => graph.isolated || graph.legacyAlternatives);
  const input = (graph: Contribution) => ({ ...graph, nodes: [...graph.nodes ?? [], ...graph.projects ?? []] });
  const registry = await compileAuthoredGraphs(standard.map(input));
  const standardTypes = registry.flatMap(result => result.types);
  // An optional install cannot take a dependency on records from a demo.
  for (const graph of combined.filter(graph => graph.scope === "addon"))
    await compileAuthoredGraphs([...standard, graph].map(input));
  const results = await compileAuthoredGraphs(combined.map(input));
  const compiled = combined.map((graph, index) => ({ graph, result: results[index] }));
  for (const graph of variants) {
    const alternatives = new Set(graph.legacyAlternatives);
    const dependencies = standard.filter(source => !alternatives.delete(`${source.namespace}/${source.name}`))
      .map(source => ({ ...source, nodes: [], edges: [], projects: [] }));
    if (alternatives.size) throw Error(`Unknown alternate graph contributions for ${graph.namespace}/${graph.name}: ${[...alternatives].join(", ")}`);
    const result = await compileAuthoredGraphs([...dependencies, graph].map(input));
    compiled.push({ graph, result: result.at(-1)! });
  }
  const stale: string[] = [];
  const write = async (path: string, data: unknown) => {
    if (!check) await mkdir(dirname(path), { recursive: true });
    if (await syncFile(path, `${JSON.stringify(data, null, 2)}\n`, check)) stale.push(path);
  };
  for (const { graph, result: { types, nodes, edges } } of compiled) {
    const split = graph.nodes?.length ?? 0;
    const data = graph.format
      ? { format: graph.format, nodes: nodes.slice(0, split), edges, ...(graph.projects && { projects: nodes.slice(split) }) }
      : { types, nodes, edges };
    await write(join(apps, graph.namespace, "graph/.compiled", `${graph.name}.json`), data);
  }
  await write(join(apps, "onto/graph/.compiled/standard-types.json"), standardTypes);
  await write(join(sdk, "graph/standard-types.json"), graphTypeRows(standardTypes));
  stale.push(...await writeGraphTypes(standardTypes, join(sdk, "tsconfig.json"), { check }));
  return stale;
}

if (import.meta.main) exitIfStale(await composeGraphs({ check: process.argv.includes("--check") }), "scripts/compose-graphs.ts");

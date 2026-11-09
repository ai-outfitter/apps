import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { wikiGraphReadInput, WikiGraphSnapshot } from "@ai-outfitter/onto/contracts";
import type { z } from "zod";
import { readGraph, type Database } from "./graph";

/** First implementation deliberately reuses the Wiki's existing bulk reader.
 * Queries can be optimized here without changing clients or coupling retrieval to Markdown. */
export async function readGraphSnapshot(
  db: Database, identity: AppIdentity, input: z.infer<typeof wikiGraphReadInput>,
): Promise<WikiGraphSnapshot> {
  const graph = await readGraph(db, identity);
  const nodes = graph.nodes.filter(row => !row.archived);
  let edges = input.includeArchivedEdges ? graph.edges : graph.edges.filter(row => !row.archived);
  const present = new Set(nodes.map(row => row.id));
  if (!input.includeArchivedEdges)
    edges = edges.filter(row => present.has(row.fromId) && present.has(row.toId));
  const typeIds = new Set([...nodes, ...edges].map(row => row.typeId));
  const result: WikiGraphSnapshot = {
    version: 1 as const, installationId: identity.installationId,
    types: graph.types.filter(row => input.includeArchivedTypes || !row.archived || typeIds.has(row.id)),
    nodes, edges, selection: null, truncated: false, missingTypes: [],
  };
  // Keep the result below the shared action transport limit. Never cut authored fields.
  if (new TextEncoder().encode(JSON.stringify(result)).length > 8 * 1024 * 1024 - 32 * 1024)
    throw new Response("Knowledge graph is too large; read a bounded selection with graph.query or GraphQL", { status: 413 });
  return result;
}

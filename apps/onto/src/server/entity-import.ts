import type { EntityRef } from "@ai-outfitter/app-sdk/entities";
import { type AppIdentity, requireEditor } from "@ai-outfitter/app-sdk/server";
import type { z } from "zod";
import { sql } from "drizzle-orm";
import { entityImport } from "../lib/entity-import";
import { core, type Graph, type GraphNode, validateProperties } from "../lib/graph";
import { validateKnowledgeGraph } from "../lib/knowledge-graph-document";
import { type Database, readGraph } from "./graph";
import { guardedGraphBatch } from "./graph-batch";
import { requireOntologyValid } from "../lib/ontology-validation";

function validateNodes(nodes: z.infer<typeof entityImport>["nodes"], graph: Graph, existing: Map<string, GraphNode>) {
  for (const node of nodes) {
    if (existing.has(node.id) && existing.get(node.id)?.typeId !== node.typeId)
      throw new Response("An existing ID has a different entity type.", { status: 409 });
    if (existing.has(node.id)) continue;
    const type = graph.types.find((type) => type.id === node.typeId && type.category === "node" && !type.archived);
    if (!type) throw new Response("Choose an active entity type.", { status: 400 });
    validateProperties(type, node.properties);
    if (node.typeId === core.knowledgeGraph) validateKnowledgeGraph(graph, node);
  }
}
function validateEdges(edges: z.infer<typeof entityImport>["edges"], graph: Graph, allNodes: Map<string, { id: string }>) {
  for (const edge of edges) {
    const type = graph.types.find((type) => type.id === edge.typeId && type.category === "edge" && !type.archived);
    if (!type || !allNodes.has(edge.fromId) || !allNodes.has(edge.toId) || edge.fromId === edge.toId)
      throw new Response("Choose an active relationship type and existing endpoints.", { status: 400 });
    validateProperties(type, edge.properties);
  }
}
/** Add-only import: a stable ID never overwrites an existing entity or its private fields. */
export async function importEntities(db: Database, who: AppIdentity, input: unknown, projectReferences: Map<string, EntityRef> = new Map()) {
  requireEditor(who);
  const parsed = entityImport.safeParse(input);
  if (!parsed.success) throw new Response(parsed.error.message, { status: 400 });
  const file = parsed.data;
  const graph = await readGraph(db, who);
  const existing = new Map(graph.nodes.map((node) => [node.id, node]));
  const slugs = new Set(graph.nodes.map((node) => node.slug));
  const fresh = file.nodes.filter((node) => !existing.has(node.id));
  validateNodes(file.nodes, graph, existing);
  for (const node of fresh) {
    if (slugs.has(node.slug)) throw new Response(`Address already in use: ${node.slug}`, { status: 409 });
    slugs.add(node.slug);
  }
  const allNodes = new Map([...graph.nodes, ...fresh].map((node) => [node.id, node]));
  const freshEdges = file.edges.filter((edge) => !graph.edges.some((saved) => saved.id === edge.id || (!saved.validity && !edge.validity && saved.typeId === edge.typeId && saved.fromId === edge.fromId && saved.toId === edge.toId)));
  validateEdges(freshEdges, graph, allNodes);
  requireOntologyValid(graph, { ...graph, nodes: [...graph.nodes, ...fresh], edges: [...graph.edges, ...freshEdges] }, new Map([...fresh, ...freshEdges].map((row) => [row.id, `$import-${row.id}`])));
  if (fresh.length || freshEdges.length) {
    const now = Date.now();
    await guardedGraphBatch(db, who, graph, [
      sql`INSERT INTO graph_nodes (id,typeId,slug,title,summary,body,website,properties,source,validity,archived,revision,createdBy,updatedBy,createdAt,updatedAt)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.typeId'),json_extract(value,'$.slug'),json_extract(value,'$.title'),json_extract(value,'$.summary'),json_extract(value,'$.body'),json_extract(value,'$.website'),json_extract(value,'$.properties'),json_extract(value,'$.source'),json_extract(value,'$.validity'),json_extract(value,'$.archived'),1,${who.userId},${who.userId},${now},${now}
      FROM json_each(${JSON.stringify(fresh.map((node) => ({ ...node, source: projectReferences.get(node.id) ?? null })))})`,
      sql`INSERT INTO graph_edges (id,typeId,fromId,toId,title,body,properties,validity,archived,revision,createdBy,updatedBy,createdAt,updatedAt)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.typeId'),json_extract(value,'$.fromId'),json_extract(value,'$.toId'),json_extract(value,'$.title'),json_extract(value,'$.body'),json_extract(value,'$.properties'),json_extract(value,'$.validity'),json_extract(value,'$.archived'),1,${who.userId},${who.userId},${now},${now}
      FROM json_each(${JSON.stringify(freshEdges)})`,
    ], "Graph changed; retry local import");
  }
  return { added: fresh.length, unchanged: file.nodes.length - fresh.length, edgesAdded: freshEdges.length };

}

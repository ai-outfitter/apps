import { core, type Graph, type GraphNode } from "./graph";
import { isRetired, loadKnowledgeGraph, type ResolvedGraphPattern } from "@ai-outfitter/app-sdk/knowledge-graph";
export { definitionPattern, graphPattern, knowledgeGraphDefinitionSchema, contextDefinition, parseKnowledgeGraph, resolveKnowledgeGraph, loadKnowledgeGraph, exploreKnowledgeGraph } from "@ai-outfitter/app-sdk/knowledge-graph";
export type { KnowledgeGraphDefinition, GraphPattern, ResolvedGraphPattern } from "@ai-outfitter/app-sdk/knowledge-graph";
export type KnowledgeGraphLens = { node: GraphNode; attached: boolean } & (
  | { definition: ResolvedGraphPattern; error?: never }
  | { definition?: never; error: string }
);
export function knowledgeGraphsFor(
  graph: Graph,
  anchor: GraphNode,
): KnowledgeGraphLens[] {
  const attached = new Set(
    graph.edges
      .filter(
        (edge) =>
          !edge.archived &&
          edge.typeId === core.lensFor &&
          edge.toId === anchor.id,
      )
      .map((edge) => edge.fromId),
  );
  const anchorType = graph.types.find((type) => type.id === anchor.typeId);
  return graph.nodes
    .filter(node => !node.archived && node.typeId === core.knowledgeGraph)
    .flatMap<KnowledgeGraphLens>(node => {
      const isAttached = attached.has(node.id);
      const legacyMatch = [anchor.typeId, anchorType?.name].includes(String(node.properties.root_type ?? "").trim());
      try {
        const definition = loadKnowledgeGraph(graph, node);
        if (!isAttached && !definition.rootTypes.includes(anchor.typeId)) return [];
        return [{ node, attached: isAttached, definition }];
      } catch (error) {
        if (!isAttached && !legacyMatch) return [];
        return [{ node, attached: isAttached, error: error instanceof Error ? error.message : String(error) }];
      }
    });
}
/** A record a knowledge graph starts from; `attached` when the graph is linked to it. */
export type KnowledgeGraphInstance = { root: GraphNode; attached: boolean };
/**
 * The records a knowledge graph can be explored from: its attached records
 * first, then every other record of its root types, by title. A record the
 * graph's first step never leaves draws an empty graph, so it is left out.
 * Throws when the graph has no selection to explore (a saved query only).
 */
export function knowledgeGraphInstances(graph: Graph, node: GraphNode): KnowledgeGraphInstance[] {
  const definition = loadKnowledgeGraph(graph, node);
  const attached = new Set(graph.edges.filter(edge => !edge.archived && edge.typeId === core.lensFor && edge.fromId === node.id).map(edge => edge.toId));
  // Same visibility as the walk: archived or retired records and edges are never traversed.
  const typeOf = new Map(graph.nodes.filter(record => !record.archived && !isRetired(record)).map(record => [record.id, record.typeId]));
  const starts = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.archived || isRetired(edge) || edge.fromId === edge.toId || !typeOf.has(edge.fromId) || !typeOf.has(edge.toId)) continue;
    for (const rule of definition.rules) {
      if (edge.typeId !== rule.type || (rule.fromType && typeOf.get(edge.fromId) !== rule.fromType) || (rule.toType && typeOf.get(edge.toId) !== rule.toType)) continue;
      starts.add(rule.direction === "incoming" ? edge.toId : edge.fromId);
    }
  }
  return graph.nodes
    .filter(root => root.id !== node.id && starts.has(root.id) && (attached.has(root.id) || definition.rootTypes.includes(root.typeId)))
    .map(root => ({ root, attached: attached.has(root.id) }))
    .sort((a, b) => Number(b.attached) - Number(a.attached) || a.root.title.localeCompare(b.root.title));
}

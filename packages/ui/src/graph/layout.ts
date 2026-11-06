import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type {
  KnowledgeGraphData as Graph,
  KnowledgeGraphEdge as GraphEdge,
  KnowledgeGraphNode as GraphNode,
} from "./model";

const elk = new ELK();
export type GraphSlice = { nodes: GraphNode[]; edges: GraphEdge[] };
export type RelationGroup = { label: string; edges: GraphEdge[] };

/** Layout-only junctions bundle repeated predicates; canonical Wiki records stay unchanged. */
export async function layoutKnowledgeGraph(graph: Graph, view: GraphSlice, options: { direction?: "RIGHT" | "DOWN" } = {}) {
  const records = new Map(view.nodes.map((node) => [node.id, node]));
  const groups = new Map<string, RelationGroup>();
  const edgeRecords = new Map<string, string[]>();
  const stems = new Set<string>();
  const children: ElkNode[] = view.nodes.map((node) => ({
    id: node.id,
    width: 240,
    height: 90,
  }));
  const edges: ElkExtendedEdge[] = [];
  const predicates = new Map<string, GraphEdge[]>();
  for (const edge of view.edges) {
    const key = JSON.stringify([
      edge.fromId,
      edge.typeId,
      edge.properties.path ?? null,
    ]);
    predicates.set(key, [...(predicates.get(key) ?? []), edge]);
  }
  const labelFor = (edge: GraphEdge) => {
    const predicate =
      graph.types.find((type) => type.id === edge.typeId)?.name ?? "related";
    return edge.properties.path
      ? `${predicate}: ${edge.properties.path}`
      : predicate;
  };
  for (const members of predicates.values()) {
    const first = members[0],
      label = labelFor(first);
    if (members.length > 1) {
      const id = `relation-group:${groups.size}`,
        stem = `${id}:stem`;
      groups.set(id, { label, edges: members });
      children.push({
        id,
        width: Math.max(80, label.length * 7 + 58),
        height: 34,
      });
      edges.push({ id: stem, sources: [first.fromId], targets: [id] });
      edgeRecords.set(
        stem,
        members.map((edge) => edge.id),
      );
      stems.add(stem);
      for (const edge of members) {
        edges.push({ id: edge.id, sources: [id], targets: [edge.toId] });
        edgeRecords.set(edge.id, [edge.id]);
      }
    } else {
      edges.push({
        id: first.id,
        sources: [first.fromId],
        targets: [first.toId],
        labels: [
          {
            text: label,
            width: Math.min(260, label.length * 7 + 24),
            height: 28,
          },
        ],
      });
      edgeRecords.set(first.id, [first.id]);
    }
  }
  const layout = await elk.layout<ElkNode>({
    id: "knowledge-graph",
    children,
    edges,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": options.direction ?? "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=32,left=32,bottom=32,right=32]",
      "elk.spacing.nodeNode": "72",
      "elk.spacing.edgeNode": "32",
      "elk.spacing.edgeEdge": "24",
      "elk.layered.spacing.nodeNodeBetweenLayers": "100",
      "elk.layered.spacing.edgeNodeBetweenLayers": "32",
      "elk.layered.layering.strategy": "NETWORK_SIMPLEX",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.edgeLabels.inline": "true",
    },
  });
  return { layout, records, groups, edgeRecords, stems };
}
export type KnowledgeGraphLayout = Awaited<
  ReturnType<typeof layoutKnowledgeGraph>
>;

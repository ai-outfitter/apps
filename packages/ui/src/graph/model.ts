/** Renderer input only. Applications own graph selection, permissions and navigation. */
export type KnowledgeGraphNode = { id: string; typeId: string; title: string };
export type KnowledgeGraphEdge = {
  id: string;
  typeId: string;
  fromId: string;
  toId: string;
  properties: Record<string, unknown>;
};
export type KnowledgeGraphData = {
  types: { id: string; name: string; title: string }[];
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
};
export type KnowledgeGraphSlice = Pick<KnowledgeGraphData, "nodes" | "edges">;

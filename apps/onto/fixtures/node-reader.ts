import { wikiGraph } from "@ai-outfitter/app-sdk/graph-contracts";
import compiled from "../graph/.compiled/reader-fixture.json" with { type: "json" };
import type { Graph } from "../src/lib/graph";
export { controlPresentation, readerBody, readerId } from "../graph/reader-fixture";

const stamp = {
  revision: 1,
  createdBy: "demo",
  updatedBy: "demo",
  createdAt: 1792886400000,
  updatedAt: 1792886400000,
};
export function readerFixture(): Graph {
  const graph = wikiGraph.parse(compiled);
  return {
    canEdit: false,
    types: graph.types.map(type => ({ ...type, seedVersion: 1, ...stamp })),
    nodes: graph.nodes.map(node => ({ ...node, source: null, ...stamp })),
    edges: graph.edges.map(edge => ({ ...edge, ...stamp })),
  };
}

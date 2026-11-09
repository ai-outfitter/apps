import { requireOntologyValid } from "./ontology-validation";
import { wikiGraph } from "@ai-outfitter/onto/contracts";
import { documentSchema } from "@ai-outfitter/app-sdk/agent-schema";
import entities from "../../seeds/entities-v1.json";
import knowledgeGraphs from "../../seeds/knowledge-graphs-v1.json";
import artifacts from "../../seeds/artifacts-v1.json";
import releases from "../../seeds/releases-v1.json";
import { defaultTypes } from "./default-types";
import { seedDocument } from "./entity-import";
import { validateProperties } from "./graph";
import { validateKnowledgeGraph } from "./knowledge-graph-document";

const base = seedDocument.parse(entities);
const nodes = [...base.nodes, ...knowledgeGraphs.nodes, ...artifacts.nodes, ...releases.nodes];
const nodeIds = new Set(nodes.map((node) => node.id));
// Canonical Project records remain Planning's responsibility.
export const standardData = wikiGraph.parse({
  types: defaultTypes,
  nodes,
  edges: [...base.edges, ...releases.edges].filter(
    (edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId),
  ),
});
function validateOntology(graph: typeof standardData) {
  requireOntologyValid({ types: [], nodes: [], edges: [] }, graph);
}
export function validateSeed(graph: typeof standardData) {
  validateOntology(graph);
  for (const key of ["types", "nodes", "edges"] as const)
    if (new Set(graph[key].map((row) => row.id)).size !== graph[key].length)
      throw new Error(`Duplicate seed ${key} ID`);
  if (new Set(graph.types.map((t) => t.name)).size !== graph.types.length)
    throw new Error("Duplicate seed type name");
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const node of graph.nodes) {
    const type = graph.types.find(
      (t) => t.id === node.typeId && t.category === "node",
    );
    if (!type) throw new Error(`Unknown seed node type: ${node.typeId}`);
    validateProperties(type, node.properties);
    if (type.jsonSchema)
      documentSchema(type.jsonSchema).parse(JSON.parse(node.body));
    if (type.name === "KnowledgeGraph") validateKnowledgeGraph(graph, node);
  }
  for (const edge of graph.edges) {
    const type = graph.types.find(
      (t) => t.id === edge.typeId && t.category === "edge",
    );
    if (!type || !ids.has(edge.fromId) || !ids.has(edge.toId))
      throw new Error(`Invalid seed relationship: ${edge.id}`);
    validateProperties(type, edge.properties);
  }
}
validateSeed(standardData);

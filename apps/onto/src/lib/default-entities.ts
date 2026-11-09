import entities from "../../seeds/entities-v1.json";
import knowledgeGraphs from "../../seeds/knowledge-graphs-v1.json";
import artifacts from "../../seeds/artifacts-v1.json";
import releases from "../../seeds/releases-v1.json";
import releaseExample from "../../seeds/release-example-v1.json";
import { entityImportEdge, seedDocument } from "./entity-import";

const seed = seedDocument.parse(entities);
const example = seedDocument.parse(releaseExample);
// Synthetic examples are demo/local content. Production setup installs the
// standard types and reusable lens, never fictional releases or approvals.
export const defaultEntities = [
  ...seed.nodes,
  ...seed.projects,
  ...knowledgeGraphs.nodes.map((node) =>
    seedDocument.shape.nodes.element.parse(node),
  ),
  ...artifacts.nodes.map((node) => seedDocument.shape.nodes.element.parse(node)),
  ...releases.nodes.map((node) => seedDocument.shape.nodes.element.parse(node)),
  ...example.nodes,
];
export const defaultEdges = [
  ...seed.edges,
  ...releases.edges.map((edge) => entityImportEdge.parse(edge)),
  ...example.edges,
];

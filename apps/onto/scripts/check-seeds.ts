import { wikiGraph } from "@ai-outfitter/app-sdk/graph-contracts";
import example from "../seeds/release-example-v1.json";
import { defaultTypes } from "../src/lib/default-types";
import { defaultEntities, defaultEdges } from "../src/lib/default-entities";
import { validateSeed } from "../src/lib/standard-data";
import { core } from "../src/lib/graph";
const nodes = defaultEntities.filter((node) => node.typeId !== core.project);
const ids = new Set(nodes.map((node) => node.id));
validateSeed(
  wikiGraph.parse({
    types: defaultTypes,
    nodes,
    edges: defaultEdges.filter(
      (edge) => ids.has(edge.fromId) && ids.has(edge.toId),
    ),
  }),
);
console.log(
  `Validated JSON seeds: ${defaultTypes.length} types; ${example.nodes.length} synthetic example records. No SQL generated.`,
);

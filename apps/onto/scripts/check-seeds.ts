import { wikiGraph } from "@ai-outfitter/app-sdk/graph-contracts";
import example from "../graph/.compiled/release-example-v1.json" with { type: "json" };
import { defaultTypes } from "../src/lib/default-types";
import { defaultEntities, defaultEdges } from "../src/lib/default-entities";
import { validateSeed } from "../src/lib/standard-data";

validateSeed(wikiGraph.parse({ types: defaultTypes, nodes: defaultEntities, edges: defaultEdges }));
console.log(
  `Validated graph seeds: ${defaultTypes.length} types; ${example.nodes.length} synthetic example records.`,
);

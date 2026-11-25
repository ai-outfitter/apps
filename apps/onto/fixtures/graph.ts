import compiled from "../graph/.compiled/demo-fixture.json";
import { wikiGraph } from "@ai-outfitter/app-sdk/graph-contracts";
import { readerFixture } from "./node-reader";
import { defaultEntities, defaultEdges } from "../src/lib/default-entities";
import { seedDocument } from "../src/lib/entity-import";
import competitiveExample from "../graph/.compiled/competitors.json";
import { defaultTypes } from "../src/lib/default-types";
import type { Graph } from "../src/lib/graph";

const stamp = {
  revision: 1,
  createdBy: "demo",
  updatedBy: "demo",
  createdAt: 1792886400000,
  updatedAt: 1792886400000,
};
// Fictional competitors so the demo's Competitive landscape has something to show. Demo only.
const competitors = seedDocument.parse(competitiveExample);
const demoExample = wikiGraph.parse(compiled);
export const demoGraph: Graph = {
  canEdit: false,
  home: { organizationId: "73000000-0000-4000-8000-000000000001" },
  types: defaultTypes.map(t => ({ ...t, ...stamp, seedVersion: 1 })),
  nodes: [...defaultEntities, ...competitors.nodes, ...demoExample.nodes].map(node => ({ ...node, source: null, ...stamp })),
  edges: [...defaultEdges, ...competitors.edges, ...demoExample.edges].map(edge => ({ ...edge, ...stamp })),
};

// Read-only example for the schema-driven reader; never installed into real Wikis.
const reader = readerFixture();
demoGraph.types.push(...reader.types);
demoGraph.nodes.push(...reader.nodes);
demoGraph.edges.push(...reader.edges);

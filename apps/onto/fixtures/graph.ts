import { readerFixture } from "./node-reader";
import { defaultEntities, defaultEdges } from "../src/lib/default-entities";
import { seedDocument } from "../src/lib/entity-import";
import competitiveExample from "./competitors.json";
import { defaultTypes } from "../src/lib/default-types";
import { core, type Graph } from "../src/lib/graph";

const stamp = {
  revision: 1,
  createdBy: "demo",
  updatedBy: "demo",
  createdAt: 1792886400000,
  updatedAt: 1792886400000,
};
// Fictional competitors so the demo's Competitive landscape has something to show. Demo only.
const competitors = seedDocument.parse(competitiveExample);
const id = (i: number) =>
  `72000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
export const demoGraph: Graph = {
  canEdit: false,
  home: { organizationId: "73000000-0000-4000-8000-000000000001" },
  types: defaultTypes.map((t) => ({ ...t, id: t.id, ...stamp, seedVersion: 1 })),
  nodes: [...[...defaultEntities, ...competitors.nodes].map((node) => ({ ...node, source: null, ...stamp })), {
    id: id(50), typeId: core.knowledgeGraph, slug: "project-context",
    title: "Project context", summary: "Explore a project and its connected context.",
    body: "Follow project participants, dependencies, and their providers.", website: null, source: null,
    properties: { root_type: "Project", pattern: JSON.stringify({ relationships: ["belongs_to_unit", "uses", { type: "participant", direction: "incoming" }, "developed_by"], max_depth: 2 }) },
    archived: false, ...stamp,
  }, ...[
    [
      core.project,
      "Meze",
      "mezi",
      "A project exploring health data, in Life Sciences.",
    ],
    [
      core.unit,
      "Life Sciences",
      "life-sciences",
      "Projects improving everyday health.",
    ],
    [
      core.software,
      "Apple Health",
      "apple-health",
      "Apple's health app. Separate from the HealthKit framework.",
    ],
    [core.organization, "Apple", "apple", "Developer of Apple Health."],
    [core.person, "Project lead", "project-lead", "A human participant."],
    [core.project, "Other project", "other-project", "No graph attached."],
  ].map(([typeId, title, slug, body], i) => ({
    id: id(i + 1),
    typeId,
    title,
    slug,
    body,
    summary: "",
    website: null,
    source: null,
    properties: {},
    archived: false,
    ...stamp,
  }))],
  edges: [...[...defaultEdges, ...competitors.edges].map((edge) => ({ ...edge, ...stamp })), ...[
    [core.belongs, 1, 2, "Current project grouping"],
    [
      core.uses,
      1,
      3,
      "Proposed integration; no working connector is asserted.",
    ],
    [core.developed, 3, 4, "Apple develops the Health app."],
    [core.participates, 5, 1, "Project participation does not grant access."],
    [core.lensFor, 50, 1, "Project context starts at Meze."],
  ].map(([typeId, from, to, body], i) => ({
    id: id(i + 101),
    typeId: String(typeId),
    fromId: id(Number(from)),
    toId: id(Number(to)),
    body: String(body),
    title: "",
    properties: Object.fromEntries(i === 1 ? [["status", "proposed"]] : []),
    archived: false,
    ...stamp,
  }))],
};

// Read-only example for the schema-driven reader; never installed into real Wikis.
const reader = readerFixture();
demoGraph.types.push(...reader.types);
demoGraph.nodes.push(...reader.nodes);
demoGraph.edges.push(...reader.edges);

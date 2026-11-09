import type {
  Graph,
  GraphNode,
  GraphEdge,
  TypeDefinition,
} from "../../src/lib/graph";

export const releaseId = (n: number) =>
  `98000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = {
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  createdBy: null,
  updatedBy: null,
  archived: false,
};
export function projectReleasesFixture(): Graph {
  const types: TypeDefinition[] = [
    "Project",
    "Release",
    "Document",
    "Demonstration",
    "part_of",
    "documents",
    "includes_record",
  ].map((name, i) => ({
    ...stamp,
    id: releaseId(100 + i),
    name,
    title: name,
    category: i < 4 ? "node" : "edge",
    body: "Fixture definition",
    properties: [],
    seedVersion: null,
  }));
  const type = (name: string) => {
    const found = types.find((type) => type.name === name);
    if (!found) throw new Error(`Missing fixture type ${name}`);
    return found.id;
  };
  const node = (
    n: number,
    name: string,
    title: string,
    body = "",
  ): GraphNode => ({
    ...stamp,
    id: releaseId(n),
    typeId: type(name),
    title,
    summary: "",
    body,
    website: null,
    properties: {},
    source: null,
  });
  const edge = (
    n: number,
    name: string,
    from: number,
    to: number,
  ): GraphEdge => ({
    ...stamp,
    id: releaseId(n),
    typeId: type(name),
    title: name,
    body: "",
    properties: {},
    fromId: releaseId(from),
    toId: releaseId(to),
  });
  const project = node(1, "Project", "Garden sensor");
  project.source = {
    installationId: "planning",
    type: "project",
    id: releaseId(9),
  };
  const other = node(4, "Project", "Garden sensor");
  other.source = {
    installationId: "foreign-planning",
    type: "project",
    id: releaseId(9),
  };
  return {
    canEdit: false,
    types,
    nodes: [
      project,
      node(
        2,
        "Release",
        "Sensor draft press release",
        JSON.stringify({
          stage: "draft",
          headline: "Know when your plant needs care",
          subheadline: "A proposed home sensor",
          inScope: [{ statement: "Plant-care alerts" }],
          outOfScope: [
            { statement: "Automatic watering", reason: "Later release" },
          ],
          customerQuote: {
            text: "An imagined customer response",
            persona: "Home grower",
            hypothetical: true,
          },
          openQuestions: ["Shipping date"],
        }),
      ),
      node(
        3,
        "Document",
        "Sensor press release and evidence bundle",
        "## Evidence inventory\n\nDraft scope only.\n\n## Evidence gaps\n\nSensor tests are pending.\n\n![Tracking image](https://tracking.example/image.png)\n\n[Bad link](javascript:alert(1))",
      ),
      other,
      node(5, "Release", "Foreign press release"),
      node(6, "Document", "Foreign evidence"),
      node(
        7,
        "Demonstration",
        "Check a plant — abc12345",
        JSON.stringify({
          media: [
            "https://evidence.example/bundle/images/check/001-desktop-page.png",
            "javascript:alert(1)",
          ],
        }),
      ),
      node(
        8,
        "Demonstration",
        "Foreign demonstration",
        JSON.stringify({ media: ["https://evidence.example/foreign.png"] }),
      ),
    ],
    edges: [
      edge(20, "part_of", 2, 1),
      edge(21, "documents", 3, 2),
      edge(22, "part_of", 5, 4),
      edge(23, "documents", 6, 4),
      edge(24, "includes_record", 3, 7),
      edge(25, "includes_record", 6, 8),
    ],
  };
}

export const canonicalReleaseProject = {
  ref: { installationId: "planning", type: "project", id: releaseId(9) },
  revision: 1,
  title: "Garden sensor",
  references: [],
  attributes: {
    name: "Garden sensor",
    githubRepository: "",
    goals: "Review the initial sensor scope",
    userStories: "",
    pressRelease: "Draft announcement",
    demoInstructions: "",
    demoResults: "",
  },
};

export function releaseProviders() {
  return [
    {
      installationId: "planning",
      template: "planning",
      type: "project",
      collection: "projects",
      title: "Projects",
      schema: {},
      writable: true,
    },
    {
      installationId: "planning",
      template: "planning",
      type: "issue",
      collection: "issues",
      title: "Issues",
      schema: {},
      writable: true,
    },
    ...["graph-type", "graph-node", "graph-edge"].map((type) => ({
      installationId: "wiki",
      hostname: "wiki.example",
      template: "wiki-map",
      type,
      title: type,
      schema: {},
      writable: false,
    })),
  ].map((provider) => ({
    ...provider,
    description: "Synthetic fixture provider",
  }));
}

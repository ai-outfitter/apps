import type {
  Graph,
  GraphEdge,
  GraphNode,
  TypeDefinition,
} from "../../src/lib/graph";

const stamp = {
  revision: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: 1000,
  updatedAt: 1000,
  archived: false,
};
const uuid = (n: number) =>
  `99000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function fixtureItem<T>(items: T[], predicate: (item: T) => boolean): T {
  const item = items.find(predicate);
  if (item === undefined) throw new Error("Missing synthetic fixture item");
  return item;
}
export const ids = {
  revision: uuid(1),
  story: uuid(2),
  flow: uuid(3),
  missingStory: uuid(4),
  latest: uuid(5),
  old: uuid(6),
  source: uuid(7),
  demo: uuid(8),
  oldDemo: uuid(9),
  evaluation: uuid(10),
  product: uuid(11),
  project: uuid(12),
  lens: uuid(13),
};

export function evidenceFixture(): Graph {
  const types: TypeDefinition[] = ["Product", "Project", "ProductRevision", "UserStory", "UseCase", "Document", "Demonstration", "EvaluationRecord", "KnowledgeGraph", "includes_record", "evidence_for", "revision_of", "produces", "has_story", "documents", "supported_by", "lens_for"].map((name,index)=>({
    ...stamp, id:uuid(200+index), name, title:name, category:index<9?"node":"edge", body:"Synthetic fixture definition.", properties:[], seedVersion:null,
  }));
  const type = (name: string) =>
    fixtureItem(types, (type) => type.name === name).id;
  const node = (
    id: string,
    name: string,
    title: string,
    body: object = {},
  ): GraphNode => ({
    ...stamp,
    id,
    typeId: type(name),
    title,
    slug: id,
    summary: "",
    body: JSON.stringify(body),
    website: null,
    properties: {},
    source: null,
  });
  const nodes = [
    node(ids.product, "Product", "Example Web App"),
    node(ids.project, "Project", "Example Alpha project"),
    node(ids.revision, "ProductRevision", "Example Alpha", {
      identityKind: "moving_tag",
      sourceRef: "refs/tags/alpha",
      tagStatus: "proposed",
    }),
    node(ids.story, "UserStory", "Navigate the workspace", {
      actor: "a member",
      capability: "navigate between apps",
      benefit: "I can continue my work",
    }),
    node(ids.flow, "UseCase", "Workspace navigation flow", {
      steps: "Open Home; Open the sidebar; Choose an app",
      alternatives: "An unavailable app shows a recoverable error.",
    }),
    node(ids.missingStory, "UserStory", "Generate evidence with Foundry", {
      actor: "an agent",
      capability: "generate evidence",
      benefit: "reviewers can inspect changes",
    }),
    node(ids.latest, "Document", "Evidence 002 — clean main"),
    node(ids.old, "Document", "Evidence 001 — prototype"),
    node(ids.source, "Document", "Source receipt"),
    node(ids.demo, "Demonstration", "Current workspace demonstration", {
      subject: { id: ids.revision, revision: 1 },
      capturedAt: "2026-10-29T10:00:00Z",
      environment: "Local fixture",
      media: [
        "/evidence/desktop.png",
        "http://127.0.0.1:4397/mobile.png",
        "https://external.example/private.png",
        "javascript:alert(1)",
      ],
      limitations: [
        "Local browsing only; production testing has not occurred.",
      ],
    }),
    node(ids.oldDemo, "Demonstration", "Old demonstration", {
      subject: { id: ids.revision, revision: 1 },
      capturedAt: "2026-10-28T10:00:00Z",
      media: ["https://old.example/old.png"],
    }),
    node(ids.evaluation, "EvaluationRecord", "Complete workflow coverage", {
      subject: { id: ids.revision, revision: 1 },
      evidence: [{ id: ids.latest, revision: 1 }],
      result: "blocked",
    }),
    node(ids.lens, "KnowledgeGraph", "Snapshot graph"),
  ];
  fixtureItem(nodes, (node) => node.id === ids.source).body =
    "# Capture receipt\n\n```json\n" +
    JSON.stringify({
      sourceAtCapture: {
        commit: "a".repeat(40),
        dirty: false,
        appPackages: { "example.json": "digest" },
      },
      capturedAt: "2026-10-29T10:00:00Z",
      environment: "Local fixture with synthetic data",
      gallery: "http://127.0.0.1:4397/",
      assets: [
        { path: "desktop.png", viewport: "desktop", state: "page", route: "/apps", finalRoute: "/login?returnTo=%2Fapps", pageTitle: "Sign in to Example" },
        null,
        false,
      ],
    }) +
    "\n```";
  let n = 100;
  const edges: GraphEdge[] = [];
  const edge = (
    name: string,
    fromId: string,
    toId: string,
    properties: Record<string, string | number> = {},
  ) =>
    edges.push({
      ...stamp,
      id: uuid(n++),
      typeId: type(name),
      fromId,
      toId,
      title: "",
      body: "",
      properties,
    });
  edge("revision_of", ids.revision, ids.product);
  edge("produces", ids.project, ids.revision);
  edge("has_story", ids.revision, ids.story);
  edge("has_story", ids.revision, ids.missingStory);
  edge("has_story", ids.flow, ids.story);
  edge("evidence_for", ids.latest, ids.revision);
  edge("evidence_for", ids.old, ids.revision);
  edge("evidence_for", ids.demo, ids.story);
  edge("evidence_for", ids.demo, ids.flow);
  edge("evidence_for", ids.oldDemo, ids.story);
  edge("supported_by", ids.story, ids.oldDemo);
  edge("supported_by", ids.old, ids.oldDemo);
  edge("lens_for", ids.lens, ids.latest);
  for (const id of [
    ids.revision,
    ids.story,
    ids.flow,
    ids.missingStory,
    ids.source,
    ids.demo,
    ids.evaluation,
  ])
    edge("includes_record", ids.latest, id, {
      record_revision: 1,
      role: "member",
    });
  return { canEdit: false, types, nodes, edges };
}

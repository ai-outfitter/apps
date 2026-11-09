import assert from "node:assert/strict";
import test from "node:test";
import { renderArtifact } from "../src/server/artifact-preview";
import type {
  Graph,
  GraphNode,
  GraphEdge,
  TypeDefinition,
} from "../src/lib/graph";
const id = (n: number) =>
  `32000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const audit = {
  revision: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: 0,
  updatedAt: 0,
};
const node = (
  n: number,
  type: number,
  title: string,
  extra: Partial<GraphNode> = {},
): GraphNode => ({
  id: id(n),
  typeId: id(type),
  title,
  summary: "Summary",
  body: "",
  website: null,
  properties: {},
  archived: false,
  source: null,
  ...audit,
  ...extra,
});
const edge = (
  n: number,
  type: number,
  from: number,
  to: number,
): GraphEdge => ({
  id: id(n),
  typeId: id(type),
  fromId: id(from),
  toId: id(to),
  title: "",
  body: "",
  properties: {},
  archived: false,
  ...audit,
});
const graph = (): Graph => ({
  canEdit: false,
  types: [
    "Project",
    "Requirement",
    "ArtifactDefinition",
    "KnowledgeGraph",
    "has_requirement",
    "artifact_for",
    "uses_view",
  ].map(
    (name, i) =>
      ({
        id: id(100 + i),
        name,
        title: name,
        category: i < 4 ? "node" : "edge",
        body: "",
        properties: [],
        archived: false,
        seedVersion: null,
        ...audit,
      }) as TypeDefinition,
  ),
  nodes: [
    node(1, 100, "Project"),
    node(2, 101, "Selected requirement"),
    node(3, 101, "Sibling requirement"),
    node(4, 102, "Recipe", {
      body: JSON.stringify({
        outputTitle: "Brief",
        status: "proposed",
        sections: ["Requirements"],
        sectionMappings: [
          { title: "Requirements", types: ["Requirement"], mode: "summaries" },
        ],
      }),
    }),
    node(5, 103, "Lens", {
      properties: {
        root_type: "Project",
        pattern: JSON.stringify({
          relationships: ["has_requirement"],
          max_depth: 2,
        }),
      },
    }),
  ],
  edges: [
    edge(10, 104, 1, 2),
    edge(11, 104, 1, 3),
    edge(12, 105, 4, 1),
    edge(13, 106, 4, 5),
  ],
});
test("Saved lens bounds domain-neutral rendering and selected scope; previews never mutate input", () => {
  const g = graph(),
    before = structuredClone(g);
  const preview = renderArtifact(
    g,
    { anchorId: id(1), definitionId: id(4), selectedNodeIds: [id(2)] },
    "wiki",
  );
  assert.match(preview.description, /Selected requirement/);
  assert.doesNotMatch(preview.description, /Sibling requirement/);
  assert.match(preview.description, /entity reference:/);
  assert.match(preview.description, /proposed/);
  assert.deepEqual(g, before);
  const intersection = renderArtifact(
    g,
    { anchorId: id(1), definitionId: id(4), selectedNodeIds: [id(99)] },
    "wiki",
  );
  assert.deepEqual(
    intersection.nodes.map((n) => n.id),
    [id(1)],
  );
  g.edges = g.edges.filter((e) => e.id !== id(12));
  assert.throws(
    () => renderArtifact(g, { anchorId: id(1), definitionId: id(4) }, "wiki"),
    (e) => e instanceof Response && e.status === 409,
  );
});
test("Legacy descriptive recipes remain readable without inventing executable mappings", () => {
  const g = graph();
  g.nodes.find((n) => n.id === id(4))!.body = JSON.stringify({
    outputTitle: "Legacy",
    status: "proposed",
    sections: ["Human heading"],
  });
  const preview = renderArtifact(
    g,
    { anchorId: id(1), definitionId: id(4) },
    "wiki",
  );
  assert.match(preview.description, /Human heading/);
  assert.match(preview.description, /Source context/);
  assert.ok(
    preview.gaps.some((message) => message.includes("descriptive sections")),
  );
});

test("Wiki publishes read-only artifact.preview through real action dispatch", async () => {
  const { appWorker } = await import("@ai-outfitter/app-test/worker");
  const { appArtifact } = await import("@ai-outfitter/app-test/prepare");
  const app = await appWorker(
    "wiki-map",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
  const who = { userId: "owner", organizationId: "org", role: "owner" };
  const post = async (path: string, body: object) => {
    const res = await app.call(path, who, { method: "POST", body });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  };
  try {
    await post("/api/internal/app-initialize", {});
    const all: { ref: { id: string }; attributes: { name: string } }[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = (await post("/api/internal/entities/v1/list", {
        type: "graph-type",
        limit: 100,
        offset,
      })) as typeof all;
      all.push(...page);
      if (page.length < 100) break;
    }
    const typeId = (name: string) =>
      all.find((t) => t.attributes.name === name)!.ref.id;
    const create = (type: string, attributes: object) =>
      post("/api/internal/entities/v1/create", {
        type,
        attributes,
      }) as Promise<{ ref: { id: string } }>;
    const anchor = await create("graph-node", {
      typeId: typeId("Requirement"),
      title: "Bounded subject",
      body: JSON.stringify({
        statement: "Render selected nodes",
        rationale: "Keep context bounded",
        status: "proposed",
      }),
    });
    const criterion = await create("graph-node", {
      typeId: typeId("AcceptanceCriterion"),
      title: "Visible evidence",
      body: JSON.stringify({
        condition: "Render selected scope",
        expectedOutcome: "Criterion remains identifiable",
      }),
    });
    const lens = await create("graph-node", {
      typeId: typeId("KnowledgeGraph"),
      title: "Requirement lens",
      properties: {
        root_type: "Requirement",
        pattern: JSON.stringify({
          relationships: ["has_acceptance_criterion"],
          max_depth: 2,
        }),
      },
    });
    const definition = await create("graph-node", {
      typeId: typeId("ArtifactDefinition"),
      title: "Work recipe",
      body: JSON.stringify({
        artifactKind: "implementation brief",
        audience: "Implementer",
        purpose: "Bound selected work",
        outputTitle: "Bounded brief",
        sections: ["Criteria"],
        sourceScope: "Requirement only",
        refreshPolicy: "Check before submission",
        revisionPolicy: "Freeze on submission",
        status: "proposed",
        sectionMappings: [
          {
            title: "Criteria",
            types: ["AcceptanceCriterion"],
            mode: "fields",
            fields: ["condition", "expectedOutcome"],
          },
        ],
      }),
    });
    for (const [type, fromId, toId] of [
      ["has_acceptance_criterion", anchor.ref.id, criterion.ref.id],
      ["artifact_for", definition.ref.id, anchor.ref.id],
      ["uses_view", definition.ref.id, lens.ref.id],
    ])
      await create("graph-edge", { typeId: typeId(type), fromId, toId });
    // Actual Worker regression: this saved lens reaches 210 execution projections,
    // but explicit selected scope must be applied before its traversal cap.
    await app.database.batch(
      Array.from({ length: 210 }, (_, offset) => {
        const n = offset + 1000;
        return [
          app.database
            .prepare(
              "INSERT INTO graph_nodes(id,typeId,slug,title,source,createdAt,updatedAt) VALUES(?,?,?,?,?,0,0)",
            )
            .bind(
              id(n),
              typeId("AcceptanceCriterion"),
              `execution-history-${n}`,
              `Execution history ${n}`,
              JSON.stringify({
                installationId: "planning",
                type: "work-submission",
                id: id(n),
              }),
            ),
          app.database
            .prepare(
              "INSERT INTO graph_edges(id,typeId,fromId,toId,createdAt,updatedAt) VALUES(?,?,?,?,0,0)",
            )
            .bind(
              id(n + 1000),
              typeId("has_acceptance_criterion"),
              anchor.ref.id,
              id(n),
            ),
        ];
      }).flat(),
    );
    const before = await post("/api/internal/entities/v1/list", {
      type: "graph-node",
      limit: 100,
    });
    const result = (await post("/api/internal/actions/v1/call", {
      action: "artifact.preview",
      input: {
        anchorId: anchor.ref.id,
        definitionId: definition.ref.id,
        selectedNodeIds: [anchor.ref.id, criterion.ref.id],
      },
    })) as { description: string };
    assert.match(result.description, /Criterion remains identifiable/);
    assert.doesNotMatch(result.description, /Execution history/);
    assert.deepEqual(
      await post("/api/internal/entities/v1/list", {
        type: "graph-node",
        limit: 100,
      }),
      before,
    );
  } finally {
    await app.dispose();
  }
});

test("Artifact manifests bind the exact recipe, lens, relationships and types; oversized previews fail before dispatch", () => {
  const g = graph();
  const original = renderArtifact(
    g,
    { anchorId: id(1), definitionId: id(4) },
    "wiki-installation",
  );
  for (const ref of [
    { type: "graph-node", id: id(4) },
    { type: "graph-node", id: id(5) },
    { type: "graph-edge", id: id(12) },
    { type: "graph-edge", id: id(13) },
    { type: "graph-type", id: id(100) },
  ])
    assert.ok(
      original.manifest.sources.some(
        (s) =>
          s.ref.type === ref.type &&
          s.ref.id === ref.id &&
          s.ref.installationId === "wiki-installation",
      ),
    );
  g.nodes.find((n) => n.id === id(5))!.revision = 2;
  g.edges.find((e) => e.id === id(10))!.revision = 3;
  const changed = renderArtifact(
    g,
    { anchorId: id(1), definitionId: id(4) },
    "wiki-installation",
  );
  assert.equal(
    changed.manifest.sources.find((s) => s.ref.id === id(5))!.revision,
    2,
  );
  assert.equal(
    changed.manifest.sources.find((s) => s.ref.id === id(10))!.revision,
    3,
  );
  const priorRecipe = g.nodes.find((n) => n.id === id(4))!;
  priorRecipe.body = priorRecipe.body.replace('"proposed"', '"retired"');
  assert.throws(
    () => renderArtifact(g, { anchorId: id(1), definitionId: id(4) }, "wiki"),
    (e) => e instanceof Response && e.status === 409,
  );
  priorRecipe.body = priorRecipe.body.replace('"retired"', '"proposed"');
  for (let i = 20; i < 50; i++) {
    g.nodes.push(
      node(i, 101, `Requirement ${i}`, {
        body: "Large authored context ".repeat(1000),
      }),
    );
    g.edges.push(edge(200 + i, 104, 1, i));
  }
  assert.throws(
    () => renderArtifact(g, { anchorId: id(1), definitionId: id(4) }, "wiki"),
    (e) => e instanceof Response && e.status === 413,
  );
});

test("Non-rendered scope provenance uses the same snapshot and private dispatch origins become canonical references", () => {
  const g = graph();
  g.nodes.push(node(6, 101, "Scope provenance only"));
  g.edges.push(edge(14, 104, 6, 2));
  const input = {
    anchorId: id(1),
    definitionId: id(4),
    selectedNodeIds: [id(2)],
    provenance: {
      nodeIds: [id(6)],
      relationships: [{ fromId: id(6), typeId: id(104) }],
    },
  };
  const preview = renderArtifact(g, input, "scoped-wiki");
  assert.doesNotMatch(preview.description, /https?:\/\//);
  assert.doesNotMatch(
    preview.description,
    /app.internal|Scope provenance only/,
  );
  assert.match(preview.description, /entity reference:/);
  assert.ok(preview.manifest.sources.some((s) => s.ref.id === id(6)));
  assert.ok(preview.manifest.sources.some((s) => s.ref.id === id(14)));
  assert.deepEqual(
    new Set(preview.provenance.map((s) => s.id)),
    new Set([id(6), id(14)]),
  );
  g.edges.find((e) => e.id === id(14))!.archived = true;
  const changed = renderArtifact(g, input, "scoped-wiki");
  assert.deepEqual(
    changed.provenance.map((s) => s.id),
    [id(6)],
  );
});

test("Wiki applies explicit scope before lens traversal and keeps canonical source references in snapshots", () => {
  const g = graph();
  const canonical = {
    installationId: "planning-installation",
    type: "work-submission",
    id: id(900),
  };
  for (let i = 20; i < 230; i++) {
    g.nodes.push(
      node(i, 101, `Projected execution ${i}`, {
        source: { ...canonical, id: id(1000 + i) },
      }),
    );
    g.edges.push(edge(2000 + i, 104, 1, i));
  }
  const requirement = g.nodes.find((n) => n.id === id(2))!;
  requirement.source = {
    installationId: "planning-installation",
    type: "issue",
    id: id(901),
  };
  const preview = renderArtifact(
    g,
    { anchorId: id(1), definitionId: id(4), selectedNodeIds: [id(1), id(2)] },
    "wiki-installation",
  );
  assert.deepEqual(
    new Set(preview.nodes.map((n) => n.id)),
    new Set([id(1), id(2)]),
  );
  assert.deepEqual(
    preview.manifest.sources.find((row) => row.ref.id === id(2))!.references,
    [requirement.source],
  );
  assert.throws(
    () =>
      renderArtifact(
        g,
        { anchorId: id(1), definitionId: id(4) },
        "wiki-installation",
      ),
    (error) => error instanceof Response && error.status === 409,
  );
});

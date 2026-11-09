import assert from "node:assert/strict";
import test from "node:test";
import artifacts from "../seeds/artifacts-v1.json";
import definitions from "../seeds/knowledge-graphs-v1.json";
import types from "../seeds/types-v1.json";
import { core, type Graph, type GraphNode } from "../src/lib/graph";
import {
  type GraphPattern,
  knowledgeGraphDefinitionSchema,
  knowledgeGraphInstances,
  knowledgeGraphsFor,
  parseKnowledgeGraph,
  resolveKnowledgeGraph,
  exploreKnowledgeGraph as traverse,
} from "../src/lib/knowledge-graphs";

const exploreKnowledgeGraph = (
  graph: Graph,
  anchor: GraphNode,
  pattern: GraphPattern,
) => traverse(graph, anchor, resolveKnowledgeGraph(graph, pattern));

const stamp = {
  archived: false,
  revision: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: 0,
  updatedAt: 0,
};
const node = (id: string, typeId: string) => ({
  ...stamp,
  id,
  typeId,
  title: id,
  slug: id,
  summary: "",
  body: "",
  website: null,
  properties: {},
  source: null,
});
const edge = (id: string, typeId: string, fromId: string, toId: string) => ({
  ...stamp,
  id,
  typeId,
  fromId,
  toId,
  title: "",
  body: "",
  properties: {},
});
test("offering lens follows products, technologies, providers and reverse problem segments without another offering", () => {
  const lens = {
    ...node(definitions.nodes[0].id, core.knowledgeGraph),
    ...definitions.nodes[0],
    archived: false, // Historical definitions remain readable when explicitly restored.
  };
  const root = node("offering", core.offering);
  const graph: Graph = {
    canEdit: true,
    types: types as Graph["types"],
    nodes: [
      root,
      node("unrelated-offering", core.offering),
      node("unrelated-product", core.product),
      node("product", core.product),
      node("tech", core.product),
      node("org", core.organization),
      node("problem", core.problem),
      node("segment", core.customerSegment),
      lens,
    ],
    edges: [
      edge("package", core.packagesProduct, "offering", "product"),
      edge(
        "other-package",
        core.packagesProduct,
        "unrelated-offering",
        "product",
      ),
      edge("uses", core.uses, "product", "tech"),
      edge("other-uses", core.uses, "unrelated-product", "tech"),
      edge("provider", core.designed, "tech", "org"),
      edge("addresses", core.addresses, "tech", "problem"),
      edge("experiences", core.experiences, "segment", "problem"),
    ],
  };
  const pattern = parseKnowledgeGraph(lens);
  assert.deepEqual(
    knowledgeGraphsFor(graph, root).map(({ node }) => node.id),
    [lens.id],
  );
  const result = exploreKnowledgeGraph(graph, root, pattern);
  assert.deepEqual(
    result.nodes.map((n) => n.id).sort(),
    ["offering", "product", "tech", "org", "problem", "segment"].sort(),
  );
  assert.equal(
    result.edges.some((e) => e.id === "other-package"),
    false,
  );
  assert.equal(result.truncated, false);
  graph.edges.find((e) => e.id === "uses")!.archived = true;
  assert.equal(
    exploreKnowledgeGraph(graph, root, pattern).nodes.some(
      (n) => n.id === "tech",
    ),
    false,
  );
});
test("simple relationships default outgoing and depth counts hops", () => {
  const root = node("root", core.offering);
  const graph: Graph = {
    canEdit: true,
    types: types as Graph["types"],
    nodes: [
      root,
      node("product", core.product),
      node("tech", core.technology),
      node("other", core.product),
    ],
    edges: [
      edge("package", core.packagesProduct, "root", "product"),
      edge("use", core.uses, "product", "tech"),
      edge("reverse", core.uses, "other", "tech"),
      edge("cycle", core.uses, "tech", "product"),
    ],
  };
  const parse = (max_depth: number) =>
    parseKnowledgeGraph({
      properties: {
        root_type: "Offering",
        pattern: JSON.stringify({
          relationships: ["packages_product", "uses"],
          max_depth,
        }),
      },
    });
  assert.deepEqual(
    exploreKnowledgeGraph(graph, root, parse(1)).nodes.map((n) => n.id),
    ["root", "product"],
  );
  assert.deepEqual(
    exploreKnowledgeGraph(graph, root, parse(2)).edges.map((e) => e.id),
    ["package", "use", "cycle"],
  );
  assert.deepEqual(
    exploreKnowledgeGraph(graph, root, parse(10)).edges.map((e) => e.id),
    ["package", "use", "cycle"],
  );
  const incoming = parseKnowledgeGraph({
    properties: {
      root_type: core.technology,
      pattern: JSON.stringify({
        relationships: [{ type: core.uses, direction: "incoming" }],
        max_depth: 1,
      }),
    },
  });
  assert.deepEqual(
    exploreKnowledgeGraph(
      graph,
      graph.nodes.find((n) => n.id === "tech")!,
      incoming,
    ).nodes.map((n) => n.id),
    ["tech", "other", "product"],
  );
});

test("invalid definitions and unresolved type names fail explicitly", () => {
  const parse = (value: unknown) =>
    parseKnowledgeGraph({
      properties: { root_type: "Offering", pattern: JSON.stringify(value) },
    });
  for (const value of [
    { relationships: [], max_depth: 4 },
    { relationships: ["uses"], max_depth: 0 },
    { relationships: ["uses"], max_depth: 11 },
    { relationships: ["uses"], max_depth: 1.5 },
    { relationships: [{ type: "uses", direction: "sideways" }], max_depth: 4 },
    { relationships: ["uses"], max_depth: 4, nodes: {} },
  ])
    assert.throws(() => parse(value));
  assert.throws(() =>
    parseKnowledgeGraph({
      properties: { root_type: "Offering", pattern: "not JSON" },
    }),
  );
  const root = node("root", core.offering);
  assert.throws(
    () =>
      exploreKnowledgeGraph(
        {
          canEdit: true,
          nodes: [root],
          edges: [],
          types: types as Graph["types"],
        },
        root,
        parse({ relationships: ["typo"], max_depth: 4 }),
      ),
    /Unknown or ambiguous edge type/,
  );
});

test("node cap remains bounded and excludes edges to omitted nodes", () => {
  const root = node("root", core.offering);
  const graph: Graph = {
    canEdit: true,
    types: types as Graph["types"],
    nodes: [
      root,
      ...Array.from({ length: 205 }, (_, i) => node(`p${i}`, core.product)),
    ],
    edges: Array.from({ length: 205 }, (_, i) =>
      edge(`e${i}`, core.packagesProduct, "root", `p${i}`),
    ),
  };
  const result = exploreKnowledgeGraph(
    graph,
    root,
    parseKnowledgeGraph({
      properties: {
        root_type: "Offering",
        pattern: JSON.stringify({
          relationships: ["packages_product"],
          max_depth: 1,
        }),
      },
    }),
  );
  assert.equal(result.nodes.length, 200);
  assert.equal(result.edges.length, 199);
  assert.equal(result.truncated, true);
});

test("lens discovery reports invalid relationships without breaking other lenses", () => {
  const root = node("offering", core.offering);
  const lens = {
    ...node("valid", core.knowledgeGraph),
    properties: {
      root_type: " Offering ",
      pattern: JSON.stringify({ relationships: ["uses"], max_depth: 2 }),
    },
  };
  const invalid = {
    ...lens,
    id: "invalid",
    properties: {
      ...lens.properties,
      pattern: JSON.stringify({ relationships: ["missing"], max_depth: 2 }),
    },
  };
  const graph: Graph = {
    canEdit: false,
    types: types as Graph["types"],
    nodes: [root, lens, invalid],
    edges: [],
  };
  const entries = knowledgeGraphsFor(graph, root);
  assert.equal(entries.length, 2);
  assert.ok(entries[0].definition);
  assert.match(
    entries[1].error ?? "",
    /Unknown or ambiguous edge type: missing/,
  );
  graph.types = graph.types.map((type) =>
    type.id === core.uses ? { ...type, archived: true } : type,
  );
  const disabled = knowledgeGraphsFor(graph, root)[0];
  assert.ok(disabled.definition);
  assert.equal(disabled.definition.rules.length, 0);
});

test("explicit attachment selects a different root and keeps invalid attached lenses visible", () => {
  const root = node("product", core.product);
  const lens = {
    ...node("lens", core.knowledgeGraph),
    properties: {
      root_type: "Offering",
      pattern: JSON.stringify({ relationships: ["uses"], max_depth: 1 }),
    },
  };
  const graph: Graph = {
    canEdit: false,
    types: types as Graph["types"],
    nodes: [root, lens, node("tech", core.technology)],
    edges: [edge("uses", core.uses, root.id, "tech")],
  };
  assert.deepEqual(knowledgeGraphsFor(graph, root), []);
  graph.edges.push(edge("attach", core.lensFor, lens.id, root.id));
  const [entry] = knowledgeGraphsFor(graph, root);
  assert.equal(entry.attached, true);
  assert.ok(entry.definition);
  assert.deepEqual(
    traverse(graph, root, entry.definition).nodes.map((n) => n.id),
    ["product", "tech"],
  );
  lens.properties.pattern = "invalid json";
  assert.ok(knowledgeGraphsFor(graph, root)[0].error);
  graph.edges.find((e) => e.id === "attach")!.archived = true;
  assert.deepEqual(knowledgeGraphsFor(graph, root), []);
});

test("the standard organization overview is available to every Organization without per-company attachments", () => {
  const definition = definitions.nodes.find(
    (n) => n.slug === "organization-overview",
  );
  assert.ok(definition);
  const lens = { ...node(definition.id, core.knowledgeGraph), ...definition };
  const first = node("first-company", core.organization);
  const second = node("second-company", core.organization);
  const graph: Graph = {
    canEdit: false,
    types: types as Graph["types"],
    nodes: [first, second, lens],
    edges: [],
  };
  for (const company of [first, second]) {
    const available = knowledgeGraphsFor(graph, company);
    assert.deepEqual(
      available.map((entry) => entry.node.id),
      [definition.id],
    );
    assert.equal(available[0].attached, false);
    assert.ok(available[0].definition);
  }
  assert.equal(
    knowledgeGraphsFor(graph, node("a-product", core.product)).length,
    0,
  );
});

test("organization overview follows its projects, offerings, problems and measurements without expanding other companies", () => {
  const definition = definitions.nodes.find(
    (n) => n.slug === "organization-overview",
  );
  assert.ok(definition);
  const lens = { ...node(definition.id, core.knowledgeGraph), ...definition };
  const type = (name: string) => {
    const found = types.find((t) => t.name === name);
    assert.ok(found);
    return found.id;
  };
  const root = node("our-company", type("Organization"));
  const graph: Graph = {
    canEdit: false,
    types: types as Graph["types"],
    nodes: [
      root,
      lens,
      ...[
        ["our-project", "Project"],
        ["our-offering", "Offering"],
        ["our-product", "Product"],
        ["direct-product", "Product"],
        ["our-problem", "Problem"],
        ["our-segment", "CustomerSegment"],
        ["our-goal", "Goal"],
        ["our-metric", "MetricDefinition"],
        ["recorded-evidence", "Document"],
        ["other-company", "Organization"],
        ["other-project", "Project"],
        ["other-offering", "Offering"],
        ["segment-second-problem", "Problem"],
        ["other-goal", "Goal"],
        ["external-tool", "Product"],
      ].map(([id, name]) => node(id, type(name))),
    ],
    edges: [
      edge("our-membership", type("part_of"), "our-project", root.id),
      edge("direct-developed-product", type("developed_by"), "direct-product", root.id),
      edge(
        "our-commercial-context",
        type("offered_by"),
        "our-offering",
        root.id,
      ),
      edge(
        "our-package",
        type("packages_product"),
        "our-offering",
        "our-product",
      ),
      edge("our-output", type("produces"), "our-project", "our-product"),
      edge("our-problem-link", type("addresses"), "our-product", "our-problem"),
      edge(
        "our-segment-link",
        type("experiences"),
        "our-segment",
        "our-problem",
      ),
      edge("our-goal-link", type("pursues"), "our-project", "our-goal"),
      edge("our-measurement", type("measured_by"), "our-goal", "our-metric"),
      edge(
        "explicit-recorded-evidence",
        type("documents"),
        "recorded-evidence",
        "our-metric",
      ),
      edge(
        "foreign-customer-shares-problem",
        type("experiences"),
        "other-company",
        "our-problem",
      ),
      edge(
        "foreign-project-membership",
        type("part_of"),
        "other-project",
        "other-company",
      ),
      edge(
        "foreign-project-shares-product",
        type("part_of"),
        "other-project",
        "our-product",
      ),
      edge(
        "foreign-output-shares-product",
        type("produces"),
        "other-project",
        "our-product",
      ),
      edge(
        "foreign-offering-shares-product",
        type("packages_product"),
        "other-offering",
        "our-product",
      ),
      edge(
        "foreign-offering-provider",
        type("offered_by"),
        "other-offering",
        "other-company",
      ),
      edge("foreign-goal", type("pursues"), "other-company", "other-goal"),
      edge(
        "shared-segment-other-problem",
        type("experiences"),
        "our-segment",
        "segment-second-problem",
      ),
      edge("used-external-tool", type("uses"), "our-project", "external-tool"),
      edge(
        "external-provider",
        type("developed_by"),
        "external-tool",
        "other-company",
      ),
    ],
  };
  const selected = traverse(
    graph,
    root,
    resolveKnowledgeGraph(graph, parseKnowledgeGraph(lens)),
  );
  assert.deepEqual(
    selected.nodes.map((n) => n.id).sort(),
    [
      root.id,
      "our-project",
      "our-offering",
      "our-product",
      "direct-product",
      "our-problem",
      "our-segment",
      "our-goal",
      "our-metric",
      "recorded-evidence",
      "segment-second-problem",
    ].sort(),
  );
  assert.equal(selected.truncated, false);
  assert.ok(
    selected.edges.some(
      (e) =>
        e.id === "our-segment-link" &&
        e.fromId === "our-segment" &&
        e.toId === "our-problem",
    ),
    "incoming traversal preserves canonical arrows",
  );
});

test("optional endpoint guards reject unknown names and skip archived paths", () => {
  const graph: Graph = {
    canEdit: false,
    types: types as Graph["types"],
    nodes: [],
    edges: [],
  };
  const lens = {
    ...node("guarded-lens", core.knowledgeGraph),
    properties: {
      root_type: "Organization",
      pattern: JSON.stringify({
        relationships: [
          {
            type: "part_of",
            direction: "incoming",
            from_type: "Project",
            to_type: "Organization",
          },
        ],
        max_depth: 2,
      }),
    },
  };
  const resolved = resolveKnowledgeGraph(graph, parseKnowledgeGraph(lens));
  assert.equal(resolved.rules[0].fromType, core.project);
  assert.equal(resolved.rules[0].toType, core.organization);
  lens.properties.pattern = JSON.stringify({
    relationships: [{ type: "part_of", from_type: "MissingNode" }],
    max_depth: 2,
  });
  assert.throws(
    () => resolveKnowledgeGraph(graph, parseKnowledgeGraph(lens)),
    /Unknown or ambiguous node type: MissingNode/,
  );
  lens.properties.pattern = JSON.stringify({
    relationships: [{ type: "part_of", from_type: "Project" }],
    max_depth: 2,
  });
  graph.types = graph.types.map((t) =>
    t.id === core.project ? { ...t, archived: true } : t,
  );
  const disabled = resolveKnowledgeGraph(graph, parseKnowledgeGraph(lens));
  assert.deepEqual(disabled.rules, []);
  lens.properties.pattern = JSON.stringify({
    relationships: [
      { type: "part_of", from_type: "Project" },
      { type: "uses" },
    ],
    max_depth: 2,
  });
  assert.deepEqual(
    resolveKnowledgeGraph(graph, parseKnowledgeGraph(lens)).rules.map(
      (r) => r.type,
    ),
    [core.uses],
  );
  graph.types = graph.types.map((t) =>
    t.id === core.organization ? { ...t, archived: true } : t,
  );
  assert.throws(
    () => resolveKnowledgeGraph(graph, parseKnowledgeGraph(lens)),
    /Unknown or ambiguous node type: Organization/,
  );
});

test("shared context supports multiple roots and enforces its declared budget", () => {
  const definition = {
    name: "Reusable delivery context", purpose: "Read requirements for a task.",
    rootTypes: ["Project", "Product"],
    selection: { relationships: ["uses"], maxDepth: 2, maxNodes: 2 },
  };
  const lens = { ...node("shared", core.knowledgeGraph), body: JSON.stringify(definition) };
  const project = node("project", core.project), product = node("product", core.product);
  const graph: Graph = { canEdit: false, types: types as Graph["types"], nodes: [project, product, node("other", core.product), lens],
    edges: [edge("first", core.uses, project.id, product.id), edge("second", core.uses, product.id, "other")] };
  assert.equal(knowledgeGraphsFor(graph, project)[0].node.id, lens.id);
  assert.equal(knowledgeGraphsFor(graph, product)[0].node.id, lens.id);
  const selected = traverse(graph, project, resolveKnowledgeGraph(graph, parseKnowledgeGraph(lens)));
  assert.deepEqual(selected.nodes.map(n => n.id), ["project", "product"]);
  assert.equal(selected.truncated, true);
  assert.equal(selected.edges.length, 1);
  assert.throws(() => knowledgeGraphDefinitionSchema.parse({ ...definition, selection: { ...definition.selection, maxNodes: 501 } }));
  assert.throws(() => knowledgeGraphDefinitionSchema.parse({ ...definition, roles: ["CPO"] }));
});

test("shared profile reports unavailable app vocabulary as context gaps", () => {
  const lens = { ...node("shared", core.knowledgeGraph), body: JSON.stringify({
    name: "Role context", purpose: "Understand responsibilities and controls.", rootTypes: ["RoleAssignment", "NotInstalledControl"],
    selection: { relationships: ["assigned_to", "not_installed_relationship"], maxDepth: 2, maxNodes: 20 },
  }) };
  const selected = resolveKnowledgeGraph({ types: types as Graph["types"] }, parseKnowledgeGraph(lens));
  assert.deepEqual(selected.missingTypes, ["NotInstalledControl", "not_installed_relationship"]);
  assert.deepEqual(selected.rootTypes, [core.roleAssignment]);
});

test("the standard competitive landscape shows who serves an organization's use cases and offerings, and what else each competitor offers", () => {
  const definition = definitions.nodes.find((n) => n.slug === "competitive-landscape");
  assert.ok(definition);
  const lens = { ...node(definition.id, core.knowledgeGraph), ...definition };
  // UseCase is Planning's type; every other type ships in the Wiki seeds.
  const useCase = { ...stamp, id: "use-case-type", category: "node", name: "UseCase", title: "Use case", body: "", properties: [] };
  const allTypes = [...types, ...artifacts.types, ...definitions.types, useCase] as Graph["types"];
  const type = (name: string) => {
    const found = allTypes.find((t) => t.name === name);
    assert.ok(found);
    return found.id;
  };
  const root = node("our-company", type("Organization"));
  const graph: Graph = {
    canEdit: false,
    types: allTypes,
    nodes: [
      root,
      lens,
      ...[
        ["our-project", "Project"],
        ["our-use-case", "UseCase"],
        ["our-story", "UserStory"],
        ["our-offering", "Offering"],
        ["their-technology", "Technology"],
        ["their-product", "Product"],
        ["story-alternative", "Product"],
        ["their-company", "Organization"],
        ["their-offering", "Offering"],
        ["their-project", "Project"],
        ["their-other-offering", "Offering"],
        ["their-unrelated-product", "Product"],
        ["third-party-product", "Product"],
        ["third-party-company", "Organization"],
      ].map(([id, name]) => node(id, type(name))),
    ],
    edges: [
      edge("membership", type("part_of"), "our-project", root.id),
      edge("our-offer", type("offered_by"), "our-offering", root.id),
      edge("scope", type("has_use_case"), "our-project", "our-use-case"),
      edge("story", type("has_story"), "our-use-case", "our-story"),
      edge("tech-competes", type("alternative_for"), "their-technology", "our-use-case"),
      edge("product-competes-for-story", type("alternative_for"), "story-alternative", "our-story"),
      edge("offer-competes", type("alternative_for"), "their-offering", "our-offering"),
      edge("tech-in-product", type("part_of"), "their-technology", "their-product"),
      edge("maker", type("developed_by"), "their-product", "their-company"),
      edge("seller", type("offered_by"), "their-offering", "their-company"),
      // The competitor's own portfolio is shown one step from its company; its competitors stay out.
      edge("their-membership", type("part_of"), "their-project", "their-company"),
      edge("their-other-offer", type("offered_by"), "their-other-offering", "their-company"),
      edge("their-other-product", type("developed_by"), "their-unrelated-product", "their-company"),
      edge("competes-with-them", type("alternative_for"), "third-party-product", "their-other-offering"),
      edge("third-party-maker", type("developed_by"), "third-party-product", "third-party-company"),
    ],
  };
  const [entry] = knowledgeGraphsFor(graph, root);
  assert.equal(entry.node.id, definition.id);
  assert.equal(entry.attached, false);
  assert.ok(entry.definition);
  assert.deepEqual(entry.definition.missingTypes, []);
  assert.deepEqual(
    traverse(graph, root, entry.definition)
      .nodes.map((n) => n.id)
      .sort(),
    [
      root.id,
      "our-offering",
      "our-project",
      "our-story",
      "our-use-case",
      "story-alternative",
      "their-company",
      "their-offering",
      "their-other-offering",
      "their-product",
      "their-project",
      "their-technology",
      "their-unrelated-product",
    ].sort(),
  );
});

test("the competitive landscape still opens in a Wiki without Planning's use case type", () => {
  const definition = definitions.nodes.find((n) => n.slug === "competitive-landscape");
  assert.ok(definition);
  const lens = { ...node(definition.id, core.knowledgeGraph), ...definition };
  const graph: Graph = {
    canEdit: false,
    types: [...types, ...artifacts.types, ...definitions.types] as Graph["types"],
    nodes: [lens],
    edges: [],
  };
  const [entry] = knowledgeGraphsFor(graph, node("company", core.organization));
  assert.ok(entry.definition);
  assert.deepEqual([...new Set(entry.definition.missingTypes)], ["UseCase"]);
});

test("the demo Wiki's competitive landscape shows two competitors and what else they offer", async () => {
  const { demoGraph } = await import("../fixtures/graph");
  const outfitter = demoGraph.nodes.find((n) => n.title === "Outfitter")!;
  const landscape = knowledgeGraphsFor(demoGraph, outfitter).find((entry) => entry.node.slug === "competitive-landscape");
  assert.ok(landscape?.definition);
  const titles = traverse(demoGraph, outfitter, landscape.definition).nodes.map((n) => n.title);
  for (const title of ["Northwind Models (synthetic)", "Northwind Model Gateway", "Northwind Fine-tuning", "Northwind Eval Studio",
    "Harbor Agents (synthetic)", "Harbor Agent Seats", "Harbor Workflow Builder", "Harbor Support Desk"]) assert.ok(titles.includes(title), title);
  // Lumen competes with Northwind's fine-tuning, not with Outfitter.
  assert.ok(!titles.some((title) => title.startsWith("Lumen")));
});

test("instances list attached records first and leave out records that draw an empty graph", () => {
  const lens = { ...node(definitions.nodes[0].id, core.knowledgeGraph), ...definitions.nodes[0], archived: false };
  const graph: Graph = {
    canEdit: true,
    types: types as Graph["types"],
    nodes: [lens, node("b-offering", core.offering), node("a-offering", core.offering), node("lonely-offering", core.offering),
      { ...node("archived-offering", core.offering), archived: true }, node("product", core.product)],
    edges: [
      edge("a", core.packagesProduct, "a-offering", "product"),
      edge("b", core.packagesProduct, "b-offering", "product"),
      edge("gone", core.packagesProduct, "archived-offering", "product"),
      edge("attached", core.lensFor, lens.id, "b-offering"),
    ],
  };
  assert.deepEqual(knowledgeGraphInstances(graph, lens).map(({ root, attached }) => [root.id, attached]),
    [["b-offering", true], ["a-offering", false]]);
  // An edge the walk would not follow does not make an instance: retired, or to an archived record.
  graph.nodes.push({ ...node("retired-product", core.product), properties: { status: "retired" } }, { ...node("old-product", core.product), archived: true });
  graph.edges.push({ ...edge("r", core.packagesProduct, "lonely-offering", "retired-product") }, edge("o", core.packagesProduct, "lonely-offering", "old-product"),
    { ...edge("retired-edge", core.packagesProduct, "lonely-offering", "product"), properties: { status: "retired" } });
  assert.deepEqual(knowledgeGraphInstances(graph, lens).map(({ root }) => root.id), ["b-offering", "a-offering"]);
});
test("instances follow incoming first steps", () => {
  const lens = { ...node("problems", core.knowledgeGraph), body: JSON.stringify({ name: "Problems", purpose: "Who has it", rootTypes: ["Problem"],
    selection: { relationships: [{ type: "experiences", direction: "incoming" }], maxDepth: 1, maxNodes: 10 } }) };
  const graph: Graph = { canEdit: true, types: types as Graph["types"],
    nodes: [lens, node("problem", core.problem), node("quiet-problem", core.problem), node("segment", core.customerSegment)],
    edges: [edge("e", core.experiences, "segment", "problem")] };
  assert.deepEqual(knowledgeGraphInstances(graph, lens).map(({ root }) => root.id), ["problem"]);
});

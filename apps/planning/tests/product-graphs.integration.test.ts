import { wikiGraphFixture } from "@ai-outfitter/app-test/wiki-fixture";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import {
  productGraphs,
  productGraphsInput,
  readProductGraphs,
} from "../src/server/product-graphs";
const id = (n: number) =>
  `94000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (
  n: number,
  type: string,
  attributes: EntityRecord["attributes"],
  references: EntityRecord["references"] = [],
): EntityRecord => ({
  ref: { installationId: "wiki", type, id: id(n) },
  revision: 4,
  title: String(attributes.title ?? attributes.name ?? n),
  attributes,
  references,
});
const who = {
  installationId: "planning",
  organizationId: "org",
  owner: { kind: "organization" as const, id: "org" },
  userId: "reader",
  role: "member",
  canEdit: false,
};
function fixture() {
  const names = [
    "Organization",
    "Product",
    "SoftwareProduct",
    "Offering",
    "Project",
    "KnowledgeGraph",
    "part_of",
    "produces",
    "packages_product",
    "offered_by",
    "uses",
    "depends_on",
  ];
  const types = names.map((name, i) =>
    row(100 + i, "graph-type", { name, category: i < 6 ? "node" : "edge" }),
  );
  const type = (name: string) =>
    types.find((t) => t.attributes.name === name)!.ref.id;
  const node = (
    n: number,
    name: string,
    attrs: EntityRecord["attributes"] = {},
  ) => row(n, "graph-node", { typeId: type(name), ...attrs });
  const edge = (n: number, name: string, from: number, to: number) =>
    row(n, "graph-edge", {
      typeId: type(name),
      fromId: id(from),
      toId: id(to),
      properties: { status: "proposed" },
    });
  const nodes = [
    node(1, "Organization", { properties: { organization_id: "org" } }),
    node(2, "KnowledgeGraph", {
      slug: "organization-overview",
      properties: {
        root_type: "Organization",
        pattern: JSON.stringify({
          max_depth: 4,
          relationships: [
            {
              type: "part_of",
              direction: "incoming",
              from_type: "Project",
              to_type: "Organization",
            },
            {
              type: "offered_by",
              direction: "incoming",
              from_type: "Offering",
              to_type: "Organization",
            },
            {
              type: "packages_product",
              from_type: "Offering",
              to_type: "Product",
            },
            { type: "produces", from_type: "Project", to_type: "Product" },
          ],
        }),
      },
    }),
    node(3, "Product"),
    node(4, "Offering"),
    node(5, "Project"),
    node(6, "Organization"),
    node(7, "Project"),
    node(8, "Project"),
    node(9, "Project"),
    node(10, "Product"),
    node(11, "Project"),
    node(12, "Product"),
    node(13, "Offering"),
  ];
  const edges = [
    edge(201, "offered_by", 4, 1),
    edge(202, "packages_product", 4, 3),
    edge(203, "part_of", 5, 1),
    edge(204, "produces", 5, 3),
    edge(205, "part_of", 7, 6),
    edge(206, "produces", 7, 3),
    edge(207, "part_of", 8, 1),
    edge(208, "uses", 8, 3),
    edge(209, "part_of", 9, 1),
    edge(210, "part_of", 9, 10),
    edge(211, "part_of", 11, 1),
    edge(212, "part_of", 11, 3),
    edge(213, "depends_on", 11, 5),
    edge(214, "offered_by", 13, 1),
    edge(215, "packages_product", 13, 12),
  ];
  const canonical = row(80, "project", { title: "Canonical project" });
  canonical.ref.installationId = "planning";
  nodes.find((n) => n.ref.id === id(5))!.references = [canonical.ref];
  return { graph: { types, nodes, edges }, node, edge, canonical };
}
test("per-product graphs preserve canonical actual edges and exclude foreign projects or mere use", () => {
  const { graph, canonical } = fixture();
  const result = productGraphs(graph, who, {}, [canonical]);
  assert.equal(result.totalProducts, 2);
  const group = result.products.find((g) => g.product.ref.id === id(3))!;
  assert.deepEqual(
    group.projects.map((n) => n.ref.id),
    [id(5), id(11)],
  );
  assert.equal(group.offerings[0].ref.id, id(4));
  assert.equal(group.canonicalProjects[0].ref.id, canonical.ref.id);
  assert.equal(group.canonicalProjects[0].revision, 4);
  assert(
    group.graph.edges.some(
      (e) => e.id === id(204) && e.fromId === id(5) && e.toId === id(3),
    ),
  );
  assert(
    group.graph.edges.some(
      (e) => e.id === id(213) && e.fromId === id(11) && e.toId === id(5),
    ),
  );
  assert(!group.graph.nodes.some((n) => [id(7), id(8)].includes(n.id)));
  assert(!group.graph.edges.some((e) => e.id === id(208)));
  assert(
    group.graph.edges.every((e) =>
      group.graph.types.some((t) => t.id === e.typeId),
    ),
  );
  assert(!result.products.some((group) => group.product.ref.id === id(10)));
  const empty = result.products.find((g) => g.product.ref.id === id(12))!;
  assert.equal(empty.projects.length, 0);
  assert.equal(empty.graph.nodes.length, 1);
  assert.equal(empty.graph.edges.length, 0);
});
test("scope, product paging, archived facts and missing organization binding remain explicit", () => {
  const { graph } = fixture();
  let result = productGraphs(graph, who, { limit: 1 });
  assert.equal(result.products.length, 1);
  assert.equal(result.nextOffset, 1);
  graph.edges.find((e) => e.ref.id === id(210))!.attributes.archived = true;
  result = productGraphs(graph, who, {});
  assert(!result.products.some((g) => g.product.ref.id === id(10)));
  graph.nodes[0].attributes.properties = {};
  result = productGraphs(graph, who, {});
  assert.equal(result.anchorStatus, "missing");
  assert.equal(result.products.length, 0);
  assert(result.gaps.some((g) => g.code === "missing-organization-binding"));
  assert.equal(productGraphsInput.safeParse({ limit: 11 }).success, false);
});
test("product/project/edge caps disclose truncation and oversized records fail without silent shortening", () => {
  const { graph, node, edge } = fixture();
  for (let i = 0; i < 45; i++) {
    graph.nodes.push(node(500 + i, "Project"));
    graph.edges.push(
      edge(1000 + i, "part_of", 500 + i, 1),
      edge(1100 + i, "produces", 500 + i, 3),
    );
  }
  for (let i = 0; i < 35; i++) {
    graph.nodes.push(node(600 + i, "Offering"));
    graph.edges.push(
      edge(1200 + i, "offered_by", 600 + i, 1),
      edge(1300 + i, "packages_product", 600 + i, 3),
    );
  }
  for (let i = 0; i < 39; i++)
    for (let j = 1; j <= 3; j++)
      graph.edges.push(
        edge(2000 + i * 3 + j, "depends_on", 500 + i, 500 + ((i + j) % 40)),
      );
  let group = productGraphs(graph, who, {}).products.find(
    (g) => g.product.ref.id === id(3),
  )!;
  assert.equal(group.projects.length, 40);
  assert.equal(group.offerings.length, 30);
  assert.equal(group.graph.edges.length, 100);
  assert.deepEqual(group.truncated, {
    projects: true,
    offerings: true,
    edges: true,
  });
  assert(group.counts.projects > 40);
  assert.equal(group.graph.nodes.length, 41);
  const small = fixture();
  small.graph.nodes.find((n) => n.ref.id === id(3))!.attributes.body =
    "x".repeat(510 * 1024);
  assert.throws(
    () => productGraphs(small.graph, who, { limit: 1 }),
    (e: unknown) => e instanceof Response && e.status === 413,
  );
});

test("a fetched canonical local project may join a scoped product without an organization edge, but cannot introduce other products", () => {
  const { graph, node, edge, canonical } = fixture();
  const extra = node(14, "Project"),
    newProduct = node(15, "Product");
  extra.references = [{ ...canonical.ref, id: id(81) }];
  const extraCanonical = {
    ...canonical,
    ref: extra.references[0],
    title: "Scoped canonical additional project",
  };
  graph.nodes.push(extra, newProduct);
  graph.edges.push(edge(220, "part_of", 14, 3), edge(221, "produces", 14, 15));
  let result = productGraphs(graph, who, {}, [canonical]);
  assert(
    !result.products
      .find((g) => g.product.ref.id === id(3))!
      .projects.some((n) => n.ref.id === id(14)),
  );
  result = productGraphs(graph, who, {}, [canonical, extraCanonical]);
  const group = result.products.find((g) => g.product.ref.id === id(3))!;
  assert(group.projects.some((n) => n.ref.id === id(14)));
  assert(group.canonicalProjects.some((p) => p.ref.id === id(81)));
  assert(group.graph.edges.some((e) => e.id === id(220)));
  assert(!result.products.some((g) => g.product.ref.id === id(15)));
  assert(!group.projects.some((n) => n.ref.id === id(7)));
});

test("retired and foreign products stay excluded; a current-org producing project can establish product scope", () => {
  const { graph, node, edge, canonical } = fixture();
  const foreignType = row(112, "graph-type", {
    name: "developed_by",
    category: "edge",
  });
  graph.types.push(foreignType);
  const retired = node(20, "SoftwareProduct", {
    body: JSON.stringify({ status: "retired" }),
  });
  const foreign = node(21, "SoftwareProduct");
  const produced = node(22, "SoftwareProduct");
  graph.nodes.push(retired, foreign, produced);
  graph.edges.push(
    edge(230, "produces", 5, 20),
    edge(231, "produces", 5, 21),
    row(232, "graph-edge", {
      typeId: foreignType.ref.id,
      fromId: id(21),
      toId: id(6),
    }),
    edge(233, "produces", 5, 22),
  );
  let result = productGraphs(graph, who, {}, [canonical]);
  assert(
    !result.products.some((g) =>
      [id(10), id(20), id(21)].includes(g.product.ref.id),
    ),
  );
  assert(result.products.some((g) => g.product.ref.id === id(22)));
  const retiredProject = node(23, "Project", {
    body: JSON.stringify({ status: "retired" }),
  });
  retiredProject.references = [canonical.ref];
  graph.nodes.push(retiredProject);
  graph.edges.push(edge(234, "produces", 23, 3));
  result = productGraphs(graph, who, {}, [canonical]);
  assert(
    !result.products
      .find((g) => g.product.ref.id === id(3))!
      .projects.some((n) => n.ref.id === id(23)),
  );
  assert(
    !result.gaps.some(
      (g) => g.code === "unlinked-planning-project" && g.subject?.id === id(5),
    ),
  );
  assert.equal(productGraphsInput.safeParse({ nodeId: id(6) }).success, false);
  assert.equal(
    productGraphsInput.safeParse({ definitionId: id(2) }).success,
    false,
  );
});

test("the shared seeded overview includes directly developed Products only for the current organization", () => {
  const { graph, node, edge, canonical } = fixture();
  const seed = JSON.parse(
    readFileSync(
      new URL("../../onto/seeds/knowledge-graphs-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const overview = seed.nodes.find(
    (n: { slug: string }) => n.slug === "organization-overview",
  );
  const pattern = JSON.parse(overview.properties.pattern);
  for (const rule of pattern.relationships) {
    for (const [name, category] of [
      [rule.type, "edge"],
      [rule.from_type, "node"],
      [rule.to_type, "node"],
    ]) {
      if (name && !graph.types.some((t) => t.attributes.name === name))
        graph.types.push(
          row(500 + graph.types.length, "graph-type", { name, category }),
        );
    }
  }
  graph.types.find(
    (t) => t.attributes.name === "SoftwareProduct",
  )!.attributes.archived = true;
  graph.nodes.find((n) => n.ref.id === id(2))!.attributes.properties =
    overview.properties;
  graph.nodes.push(
    node(30, "Product", { title: "Planning" }),
    node(31, "Product", { title: "Foreign product" }),
  );
  graph.edges.push(
    edge(240, "developed_by", 30, 1),
    edge(241, "developed_by", 31, 6),
  );
  const result = productGraphs(graph, who, {}, [canonical]);
  assert(!result.gaps.some((g) => g.code === "invalid-overview-definition"));
  assert(result.products.some((g) => g.product.ref.id === id(30)));
  assert(!result.products.some((g) => g.product.ref.id === id(31)));
  assert(
    result.products.some(
      (g) =>
        g.product.ref.id === id(3) &&
        g.projects.some((p) => p.ref.id === id(5)),
    ),
  );
});

test("active Products reached directly through produces exclude foreign development and offering provenance", () => {
  const { graph, node, edge, canonical } = fixture();
  graph.types.push(
    row(112, "graph-type", { name: "developed_by", category: "edge" }),
  );
  graph.nodes.push(
    node(30, "Product"),
    node(31, "Product"),
    node(32, "Offering"),
    node(33, "Product"),
  );
  graph.edges.push(
    edge(240, "produces", 5, 30),
    edge(241, "developed_by", 30, 6),
    edge(242, "produces", 5, 31),
    edge(243, "packages_product", 32, 31),
    edge(244, "offered_by", 32, 6),
    edge(245, "produces", 5, 33),
    edge(246, "developed_by", 33, 1),
  );
  const result = productGraphs(graph, who, {}, [canonical]);
  assert(
    !result.products.some((group) =>
      [id(30), id(31)].includes(group.product.ref.id),
    ),
  );
  assert(result.products.some((group) => group.product.ref.id === id(33)));
});

test("Product reader selects the authenticated Planning installation when the owner has two", async () => {
  const { graph, canonical } = fixture();
  const projectReads: string[] = [];
  const providers = ["planning", "planning-other"].map((installationId) => ({
    template: "planning",
    installationId,
    type: "project",
    collection: "projects",
  }));
  providers.push(
    ...["types", "nodes", "edges"].map((collection, index) => ({
      template: "wiki-map",
      installationId: "wiki",
      type: ["graph-type", "graph-node", "graph-edge"][index],
      collection,
    })),
  );
  function listFixtureGraph(input: Record<string, unknown>) {
    const records =
      input.type === "graph-type"
        ? graph.types
        : input.type === "graph-node"
          ? graph.nodes
          : graph.edges;
    const filter = input.filter as Record<string, unknown> | undefined;
    return records
      .filter((record) =>
        Object.entries(filter ?? {}).every(([key, value]) => {
          if (key === "nodeId")
            return (
              record.attributes.fromId === value ||
              record.attributes.toId === value
            );
          if (key === "archived")
            return Boolean(record.attributes.archived) === value;
          return record.attributes[key] === value;
        }),
      )
      .slice(
        Number(input.offset ?? 0),
        Number(input.offset ?? 0) + Number(input.limit ?? 100),
      );
  }
  const host = {
    async call(operation: string, value: unknown) {
      const input = value as Record<string, unknown>;
      if (operation === "entities.types") return providers;
      if (operation === "entities.get") {
        const record = graph.nodes.find((node) => node.ref.id === input.id);
        if (!record) throw new Response("Missing", { status: 404 });
        return record;
      }
      if (operation === "actions.call" && (value as {action?: string}).action === "graph.read") return wikiGraphFixture("wiki", graph);
      assert.equal(operation, "entities.list");
      if (input.type === "project") {
        projectReads.push(String(input.installationId));
        return [canonical];
      }
      return listFixtureGraph(input);
    },
  } as unknown as WorkflowHost<"interactive">;
  const result = await readProductGraphs(
    {
      identity: who,
      host: () => host,
      db: () => {
        throw new Error("No direct database access");
      },
    },
    {},
  );
  assert.equal(result.totalProducts, 2);
  assert.deepEqual(projectReads, ["planning"]);
});

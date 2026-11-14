import assert from "node:assert/strict";
import test from "node:test";
import { appDataContext } from "@ai-outfitter/app-sdk/database";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { readScopedOrganizationGraph } from "../src/server/scoped-organization-graph";
import { productGraphs } from "../src/server/product-graphs";
const who = {
  installationId: "planning",
  userId: "owner",
  organizationId: "org",
  owner: { kind: "organization" as const, id: "org" },
  role: "owner",
  canEdit: true,
};
const row = (
  id: string,
  type: string,
  attributes: EntityRecord["attributes"],
): EntityRecord => ({
  ref: { installationId: "wiki", type, id },
  revision: 1,
  title: id,
  references: [],
  attributes: { archived: false, ...attributes },
});
function fixture() {
  const names = [
    "Organization",
    "KnowledgeGraph",
    "Project",
    "Product",
    "Offering",
    "part_of",
    "produces",
    "packages_product",
    "offered_by",
    "developed_by",
  ];
  const types = names.map((name, i) =>
    row(name, "graph-type", { name, category: i < 5 ? "node" : "edge" }),
  );
  const node = (id: string, typeId: string, body = {}) =>
    row(id, "graph-node", { typeId, body: JSON.stringify(body) });
  const edge = (id: string, typeId: string, fromId: string, toId: string) =>
    row(id, "graph-edge", { typeId, fromId, toId });
  const organization = node("org-node", "Organization");
  organization.attributes.properties = { organization_id: "org" };
  const lens = node("lens", "KnowledgeGraph");
  lens.attributes.slug = "organization-overview";
  lens.attributes.properties = {
    root_type: "Organization",
    pattern: JSON.stringify({
      max_depth: 2,
      relationships: [
        {
          type: "part_of",
          direction: "incoming",
          from_type: "Project",
          to_type: "Organization",
        },
      ],
    }),
  };
  const nodes = [organization, node("foreign-org", "Organization"), lens];
  const edges: EntityRecord[] = [];
  const queries: Record<string, unknown>[] = [];
  const gets: string[] = [];
  function listRecords(input: Record<string, unknown>) {
      const data =
        input.type === "graph-type"
          ? types
          : input.type === "graph-node"
            ? nodes
            : edges;
      const filter = (input.filter ?? {}) as Record<string, unknown>;
      if (input.type !== "graph-type")
        assert(Object.keys(filter).length, "No unfiltered graph reads");
      return data
        .filter((record) => matchesFixtureFilter(record, filter))
        .slice(
          Number(input.offset ?? 0),
          Number(input.offset ?? 0) + Number(input.limit ?? 100),
        ).map((record) => projectFixtureFields(record, input.select));
  }
  const host = {
    async call(operation: string, value: unknown) {
      const input = value as Record<string, unknown>;
      if (operation === "entities.types")
        return ["types", "nodes", "edges"].map((collection, i) => ({
          template: "wiki-map",
          collection,
          type: ["graph-type", "graph-node", "graph-edge"][i],
          installationId: "wiki",
        }));
      if (operation === "entities.get") {
        gets.push(String(input.id));
        const record = nodes.find((n) => n.ref.id === input.id);
        if (!record) throw new Response("Missing", { status: 404 });
        return record;
      }
      assert.equal(operation, "entities.list");
      queries.push(input);
      return listRecords(input);
    },
  } as unknown as WorkflowHost<"interactive">;
  return { types, nodes, edges, node, edge, queries, gets, context: appDataContext(host) };
}
test("filtered product provenance reads a foreign offering's provider even outside the lens", async () => {
  const f = fixture();
  f.nodes.push(
    f.node("project", "Project"),
    f.node("product", "Product"),
    f.node("foreign-offering", "Offering"),
  );
  f.edges.push(
    f.edge("membership", "part_of", "project", "org-node"),
    f.edge("output", "produces", "project", "product"),
    f.edge("package", "packages_product", "foreign-offering", "product"),
    f.edge("provider", "offered_by", "foreign-offering", "foreign-org"),
  );
  const graph = await readScopedOrganizationGraph(await f.context.apps.installation("wiki"), who);
  assert(graph.edges.some((edge) => edge.ref.id === "provider"));
  assert(
    f.queries.some(
      (input) =>
        JSON.stringify(input.filter) ===
        JSON.stringify({
          typeId: "offered_by",
          fromId: "foreign-offering",
          archived: false,
        }),
    ),
  );
  assert(
    !productGraphs(graph, who, {}).products.some(
      (group) => group.product.ref.id === "product",
    ),
  );
});
test("retired projects do not consume the saved overview's selection bound", async () => {
  const f = fixture();
  for (let i = 0; i < 230; i++) {
    f.nodes.push(f.node(`retired-${i}`, "Project", { status: "retired" }));
    f.edges.push(
      f.edge(`old-edge-${i}`, "part_of", `retired-${i}`, "org-node"),
    );
  }
  f.nodes.push(f.node("active-project", "Project"));
  f.edges.push(f.edge("current", "part_of", "active-project", "org-node"));
  const graph = await readScopedOrganizationGraph(await f.context.apps.installation("wiki"), who);
  assert.equal(graph.truncated, false);
  assert(graph.nodes.some((node) => node.ref.id === "active-project"));
});
test("dense neighborhoods surface truncation instead of false missing-context gaps", async () => {
  const f = fixture();
  for (let i = 0; i < 1050; i++) {
    f.nodes.push(f.node(`project-${i}`, "Project"));
    f.edges.push(f.edge(`edge-${i}`, "part_of", `project-${i}`, "org-node"));
  }
  const graph = await readScopedOrganizationGraph(await f.context.apps.installation("wiki"), who);
  assert.equal(graph.truncated, true);
  const result = productGraphs(graph, who, {});
  assert(result.gaps.some((gap) => gap.code === "truncated-overview"));
  assert(
    !result.gaps.some(
      (gap) =>
        gap.code.startsWith("missing-") ||
        gap.code === "project-outside-overview",
    ),
  );
});

function matchesFixtureFilter(record: EntityRecord, filter: Record<string, unknown> = {}) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "nodeId") return record.attributes.fromId === value || record.attributes.toId === value;
    return record.attributes[key] === value;
  });
}

function projectFixtureFields(record: EntityRecord, selected: unknown) {
  if (!Array.isArray(selected)) return record;
  return { ...record, attributes: Object.fromEntries(selected.filter(key => key in record.attributes).map(key => [key, record.attributes[key]])) };
}

test("company lookup metadata does not consume the scoped traversal node budget", async () => {
  const f = fixture();
  for (let i = 0; i < 1100; i++) f.nodes.push(f.node(`company-${i}`, "Organization"));
  f.nodes.push(f.node("our-project", "Project"), f.node("our-product", "Product"));
  f.edges.push(f.edge("own-project", "part_of", "our-project", "org-node"), f.edge("own-output", "produces", "our-project", "our-product"));
  const graph = await readScopedOrganizationGraph(await f.context.apps.installation("wiki"), who);
  assert.equal(graph.truncated, false);
  assert(graph.nodes.some(node => node.ref.id === "our-product"));
  assert(!f.gets.some(id => id.startsWith("company-")));
  const lookup = f.queries.find(input => (input.filter as Record<string, unknown>)?.typeId === "Organization");
  assert(lookup);
  assert(!(lookup.select as string[]).includes("body"));
});

test("direction guards and the depth limit prevent irrelevant endpoint fanout", async () => {
  const f = fixture();
  f.types.push(row("Problem", "graph-type", { name: "Problem", category: "node" }), row("addresses", "graph-type", { name: "addresses", category: "edge" }));
  const lens = f.nodes.find(node => node.ref.id === "lens");
  assert(lens);
  lens.attributes.properties = { root_type: "Organization", pattern: JSON.stringify({ max_depth: 1, relationships: [{ type: "addresses", from_type: "Organization", to_type: "Problem" }, { type: "addresses", from_type: "Problem", to_type: "Product" }, { type: "produces", from_type: "Project", to_type: "Product" }] }) };
  f.nodes.push(f.node("scoped-problem", "Problem"));
  f.edges.push(f.edge("our-problem", "addresses", "org-node", "scoped-problem"));
  for (let i = 0; i < 1100; i++) {
    f.nodes.push(f.node(`unrelated-${i}`, "Product"));
    f.edges.push(f.edge(`wrong-direction-${i}`, "addresses", `unrelated-${i}`, "org-node"), f.edge(`beyond-depth-${i}`, "addresses", "scoped-problem", `unrelated-${i}`), f.edge(`wrong-source-type-${i}`, "produces", "org-node", `unrelated-${i}`));
  }
  const graph = await readScopedOrganizationGraph(await f.context.apps.installation("wiki"), who);
  assert.equal(graph.truncated, false);
  assert.deepEqual(f.gets.sort(), ["org-node", "scoped-problem"]);
  assert(!f.queries.some(input => (input.filter as Record<string, unknown>)?.nodeId === "scoped-problem"));
  assert.deepEqual(graph.edges.map(edge => edge.ref.id), ["our-problem"]);
});

test("retired duplicate bindings and same-slug non-graph nodes do not prevent valid traversal", async () => {
  const f = fixture();
  const retired = f.node("retired-organization", "Organization", { status: "retired" });
  retired.attributes.properties = { organization_id: "org" };
  const wrongLens = f.node("wrong-lens", "Product");
  wrongLens.attributes.slug = "organization-overview";
  f.nodes.push(retired, wrongLens, f.node("current-project", "Project"));
  f.edges.push(f.edge("current-membership", "part_of", "current-project", "org-node"));
  const graph = await readScopedOrganizationGraph(await f.context.apps.installation("wiki"), who);
  assert(graph.edges.some(edge => edge.ref.id === "current-membership"));
  assert(!graph.nodes.some(node => node.ref.id === retired.ref.id));
  const result = productGraphs(graph, who, {});
  assert.equal(result.anchorStatus, "resolved");
  assert.equal(result.definition?.ref.id, "lens");
});

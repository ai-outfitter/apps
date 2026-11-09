import assert from "node:assert/strict";
import test from "node:test";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { exploreOrganizationGraph } from "../src/server/organization-exploration";
const id = (n: number) =>
  `93000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rec = (
  n: number,
  type: string,
  attributes: EntityRecord["attributes"],
  references: EntityRecord["references"] = [],
): EntityRecord => ({
  ref: { installationId: "wiki", type, id: id(n) },
  revision: 2,
  title: String(attributes.title ?? attributes.name ?? n),
  attributes,
  references,
});
function fixture() {
  const names = [
    "Organization",
    "KnowledgeGraph",
    "Offering",
    "Product",
    "CustomerSegment",
    "Problem",
    "Project",
    "Goal",
    "MetricDefinition",
    "offered_by",
    "packages_product",
    "customer_of",
    "experiences",
    "part_of",
    "pursues",
    "measured_by",
  ];
  const types = names.map((name, i) =>
    rec(100 + i, "graph-type", { name, category: i < 9 ? "node" : "edge" }),
  );
  const type = (n: string) =>
    types.find((t) => t.attributes.name === n)!.ref.id;
  const node = (
    n: number,
    name: string,
    attrs: EntityRecord["attributes"] = {},
  ) => rec(n, "graph-node", { typeId: type(name), ...attrs });
  const edge = (n: number, name: string, from: number, to: number) =>
    rec(n, "graph-edge", {
      typeId: type(name),
      fromId: id(from),
      toId: id(to),
    });
  const anchor = node(1, "Organization", {
    title: "Renamed business",
    properties: { organization_id: "org" },
  });
  anchor.references = [
    { installationId: "platform", type: "organization", id: "org" },
  ];
  const lens = node(2, "KnowledgeGraph", {
    slug: "organization-overview",
    properties: {
      root_type: "Organization",
      pattern: JSON.stringify({
        max_depth: 3,
        relationships: [
          { type: "offered_by", direction: "incoming" },
          "packages_product",
          { type: "customer_of", direction: "incoming" },
          "experiences",
          { type: "part_of", direction: "incoming" },
          "pursues",
          "measured_by",
        ],
      }),
    },
  });
  const nodes = [
    anchor,
    lens,
    node(3, "Offering"),
    node(4, "Product"),
    node(5, "CustomerSegment"),
    node(6, "Problem"),
    node(7, "Project"),
    node(8, "Goal"),
    node(9, "MetricDefinition"),
    node(10, "Organization", { title: "Renamed business" }),
    node(11, "Product"),
  ];
  const edges = [
    edge(201, "offered_by", 3, 1),
    edge(202, "packages_product", 3, 4),
    edge(203, "customer_of", 5, 1),
    edge(204, "experiences", 5, 6),
    edge(205, "part_of", 7, 1),
    edge(206, "pursues", 7, 8),
    edge(207, "measured_by", 8, 9),
  ];
  return { graph: { types, nodes, edges }, node, edge };
}
const who = {
  installationId: "planning",
  organizationId: "org",
  owner: { kind: "organization" as const, id: "org" },
  userId: "reader",
  role: "member",
  canEdit: false,
};
test("organization exploration follows shared saved lens directions and depth without title borrowing", () => {
  const { graph } = fixture();
  const result = exploreOrganizationGraph(
    graph,
    who,
    {},
    [],
    new Date("2026-10-29T00:00:00Z"),
  );
  assert.equal(result.organization?.ref.id, id(1));
  assert.equal(result.anchorStatus, "resolved");
  assert.equal(result.definition?.ref.id, id(2));
  assert(result.records.some((r) => r.ref.id === id(4)));
  assert(result.records.some((r) => r.ref.id === id(6)));
  assert(result.records.some((r) => r.ref.id === id(9)));
  assert(!result.records.some((r) => r.ref.id === id(11)));
  assert.deepEqual(
    result.branches.map((b) => b.id),
    ["products", "customers", "projects", "goals", "gaps"],
  );
  assert.equal(
    result.records.find((r) => r.ref.id === id(9))?.latestObservation,
    null,
  );
  assert(result.gaps.some((g) => g.code === "missing-measurement-observation"));
  const customers = exploreOrganizationGraph(graph, who, {
    branch: "customers",
    limit: 1,
  });
  assert.equal(customers.records.length, 1);
  assert.equal(customers.nextOffset, 1);
});
test("missing or ambiguous canonical binding requires explicit scoped Organization choice, never a matching title", () => {
  const { graph } = fixture();
  graph.nodes[0].attributes.properties = {};
  // An arbitrary source reference is not the canonical organization binding.
  let result = exploreOrganizationGraph(graph, who, {});
  assert.equal(result.organization, null);
  assert.equal(result.anchorStatus, "missing");
  assert.equal(result.records.length, 0);
  assert.equal(result.organizationChoices.length, 2);
  result = exploreOrganizationGraph(graph, who, { nodeId: id(1) });
  assert.equal(result.anchorStatus, "explicit");
  assert.equal(result.organization?.ref.id, id(1));
  const other = exploreOrganizationGraph(graph, who, { nodeId: id(10) });
  assert.equal(other.organization?.ref.id, id(10));
  assert.equal(other.anchorStatus, "explicit");
  assert.equal(other.ownership.organizationId, "org");
  assert.equal(other.records.length, 0);
  assert.throws(
    () => exploreOrganizationGraph(graph, who, { nodeId: id(99) }),
    (e: unknown) => e instanceof Response && e.status === 404,
  );
  assert.throws(
    () => exploreOrganizationGraph(graph, who, { nodeId: id(11) }),
    (e: unknown) => e instanceof Response && e.status === 404,
  );
  graph.nodes[0].attributes.properties = { organization_id: "org" };
  graph.nodes.find((n) => n.ref.id === id(10))!.attributes.properties = {
    organization_id: "org",
  };
  assert.equal(
    exploreOrganizationGraph(graph, who, {}).anchorStatus,
    "ambiguous",
  );
  assert.throws(
    () =>
      exploreOrganizationGraph(
        graph,
        { ...who, organizationId: undefined },
        {},
      ),
    (e: unknown) => e instanceof Response && e.status === 404,
  );
});
test("invalid definitions report repair gaps without claiming empty branches; archives and saved depth are honored", () => {
  const { graph } = fixture();
  graph.nodes[1].attributes.properties = {
    root_type: "Organization",
    pattern: "{}",
  };
  let result = exploreOrganizationGraph(graph, who, {});
  assert(result.gaps.some((g) => g.code === "invalid-overview-definition"));
  assert(!result.gaps.some((g) => g.code === "missing-products"));
  graph.nodes[1].attributes.properties = {
    root_type: "Organization",
    pattern: JSON.stringify({
      max_depth: 1,
      relationships: [{ type: "offered_by", direction: "incoming" }],
    }),
  };
  result = exploreOrganizationGraph(graph, who, {});
  assert(result.records.some((r) => r.type === "Offering"));
  assert(!result.records.some((r) => r.type === "Product"));
  graph.edges[0].attributes.archived = true;
  assert.equal(
    exploreOrganizationGraph(graph, who, { branch: "products" }).records.length,
    0,
  );
});

test("explicit organization_id binding is unique and endpoint guards use canonical direction", () => {
  const { graph, node, edge } = fixture();
  graph.nodes[0].references = [];
  graph.nodes[0].attributes.properties = { organization_id: "org" };
  assert.equal(
    exploreOrganizationGraph(graph, who, {}).anchorStatus,
    "resolved",
  );
  graph.nodes[1].attributes.properties = {
    root_type: "Organization",
    pattern: JSON.stringify({
      max_depth: 3,
      relationships: [
        {
          type: "offered_by",
          direction: "incoming",
          from_type: "Offering",
          to_type: "Organization",
        },
        {
          type: "packages_product",
          direction: "outgoing",
          from_type: "Offering",
          to_type: "Product",
        },
      ],
    }),
  };
  graph.nodes.push(node(12, "Organization"));
  graph.edges.push(
    edge(208, "offered_by", 12, 1),
    edge(209, "packages_product", 12, 11),
  );
  const result = exploreOrganizationGraph(graph, who, { branch: "products" });
  assert(result.records.some((r) => r.ref.id === id(4)));
  assert(!result.records.some((r) => r.ref.id === id(11)));
  graph.nodes.find((n) => n.ref.id === id(10))!.attributes.properties = {
    organization_id: "org",
  };
  assert.equal(
    exploreOrganizationGraph(graph, who, {}).anchorStatus,
    "ambiguous",
  );
});

test("the shared 200-node bound truncates with a gap and overview balances branches without pagination", () => {
  const { graph, node, edge } = fixture();
  for (let i = 0; i < 210; i++) {
    graph.nodes.push(node(1000 + i, "Product"));
    graph.edges.push(edge(2000 + i, "packages_product", 3, 1000 + i));
  }
  const large = exploreOrganizationGraph(graph, who, {});
  assert(large.gaps.some((g) => g.code === "truncated-overview"));
  assert(!large.gaps.some((g) => g.code.startsWith("missing-")));
  assert.equal(large.nextOffset, null);
  assert(large.records.length <= 20);
  assert.equal(large.organization?.ref.id, id(1));
  const small = fixture();
  for (let i = 0; i < 30; i++) {
    small.graph.nodes.push(small.node(500 + i, "Offering"));
    small.graph.edges.push(small.edge(3000 + i, "offered_by", 500 + i, 1));
  }
  const overview = exploreOrganizationGraph(small.graph, who, { offset: 100 });
  assert.equal(overview.nextOffset, null);
  assert(overview.records.some((r) => r.type === "Project"));
  assert(overview.records.some((r) => r.type === "Goal"));
  assert(overview.records.some((r) => r.type === "Problem"));
  assert.equal(
    overview.records.filter((r) => ["Offering", "Product"].includes(r.type))
      .length,
    5,
  );
  const branch = exploreOrganizationGraph(small.graph, who, {
    branch: "products",
    limit: 5,
  });
  assert.equal(branch.nextOffset, 5);
});

test("only organization_id binds, and malformed strict lens patterns fail explicitly", () => {
  const { graph } = fixture();
  graph.nodes[0].attributes.properties = {};
  assert.equal(
    exploreOrganizationGraph(graph, who, {}).anchorStatus,
    "missing",
  );
  const sameId = graph.nodes.find((n) => n.ref.id === id(10))!;
  sameId.ref.id = "org";
  assert.equal(
    exploreOrganizationGraph(graph, who, {}).anchorStatus,
    "missing",
  );
  graph.nodes[0].attributes.properties = { organization_id: "org" };
  graph.nodes[1].attributes.properties = {
    root_type: "Organization",
    pattern: JSON.stringify({
      max_depth: 2,
      relationships: ["addresses"],
      unexpected: true,
    }),
  };
  assert(
    exploreOrganizationGraph(graph, who, {}).gaps.some(
      (g) => g.code === "invalid-overview-definition",
    ),
  );
});

test("canonical Planning projects outside the organization lens remain explicit gaps", () => {
  const { graph } = fixture();
  const project = rec(999, "project", { title: "Hiring intake" });
  project.ref.installationId = who.installationId;
  const own = exploreOrganizationGraph(graph, who, {}, [project]);
  assert(
    own.gaps.some(
      (g) =>
        g.code === "project-outside-overview" &&
        g.subject?.id === project.ref.id,
    ),
  );
  const other = exploreOrganizationGraph(graph, who, { nodeId: id(10) }, [
    project,
  ]);
  assert(!other.gaps.some((g) => g.code === "project-outside-overview"));
});

test("archived guard or relationship skips just its rule while missing, ambiguous and archived root remain invalid", () => {
  const { graph } = fixture();
  const software = rec(9000, "graph-type", {
    name: "SoftwareProduct",
    category: "node",
    archived: true,
  });
  graph.types.push(software);
  const pattern = {
    max_depth: 3,
    relationships: [
      {
        type: "offered_by",
        direction: "incoming",
        from_type: "Offering",
        to_type: "Organization",
      },
      { type: "packages_product", from_type: "Offering", to_type: "Product" },
      {
        type: "packages_product",
        from_type: "Offering",
        to_type: "SoftwareProduct",
      },
      {
        type: "part_of",
        direction: "incoming",
        from_type: "Project",
        to_type: "Organization",
      },
    ],
  };
  graph.nodes[1].attributes.properties = {
    root_type: "Organization",
    pattern: JSON.stringify(pattern),
  };
  let result = exploreOrganizationGraph(graph, who, {});
  assert(result.records.some((n) => n.ref.id === id(4)));
  assert(result.records.some((n) => n.ref.id === id(7)));
  assert(result.gaps.some((g) => g.code === "archived-overview-paths"));
  assert(!result.gaps.some((g) => g.code === "invalid-overview-definition"));
  assert(!result.gaps.some((g) => g.code.startsWith("missing-")));
  graph.types.find(
    (t) => t.attributes.name === "part_of",
  )!.attributes.archived = true;
  result = exploreOrganizationGraph(graph, who, {});
  assert(!result.records.some((n) => n.ref.id === id(7)));
  assert(result.records.some((n) => n.ref.id === id(4)));
  assert(!result.gaps.some((g) => g.code === "missing-projects"));
  pattern.relationships[2].to_type = "AbsentProduct";
  graph.nodes[1].attributes.properties = {
    root_type: "Organization",
    pattern: JSON.stringify(pattern),
  };
  assert(
    exploreOrganizationGraph(graph, who, {}).gaps.some(
      (g) => g.code === "invalid-overview-definition",
    ),
  );
  pattern.relationships[2].to_type = "SoftwareProduct";
  graph.nodes[1].attributes.properties = {
    root_type: "Organization",
    pattern: JSON.stringify(pattern),
  };
  graph.types.push(
    rec(9001, "graph-type", { name: "SoftwareProduct", category: "node" }),
  );
  assert(
    !exploreOrganizationGraph(graph, who, {}).gaps.some(
      (g) => g.code === "invalid-overview-definition",
    ),
  );
  graph.types.push(
    rec(9002, "graph-type", { name: "SoftwareProduct", category: "node" }),
  );
  assert(
    exploreOrganizationGraph(graph, who, {}).gaps.some(
      (g) => g.code === "invalid-overview-definition",
    ),
  );
  graph.types.pop();
  graph.types.pop();
  graph.types.find(
    (t) => t.attributes.name === "Organization",
  )!.attributes.archived = true;
  assert(
    exploreOrganizationGraph(graph, who, {}).gaps.some(
      (g) => g.code === "invalid-overview-definition",
    ),
  );
});

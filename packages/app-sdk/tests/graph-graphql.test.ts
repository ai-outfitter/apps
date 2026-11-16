import assert from "node:assert/strict";
import test from "node:test";
import { getIntrospectionQuery, GraphQLObjectType, GraphQLString } from "graphql";
import { executeGraphQuery, type GraphContext, type GraphRow, type GraphSource, graphGraphqlInput, graphGraphqlResult, graphqlNames, type KeyArgs, memorySource, type TypeRow } from "../src/graph-graphql";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const type = (n: number, name: string, category: "node" | "edge", extra: Record<string, unknown> = {}) =>
  ({ id: uuid(n), name, category, title: name, body: `About ${name}.`, properties: [], archived: false, revision: 1, ...extra });
const prop = (name: string, kind: string) => ({ name, type: kind, description: name, required: false });
const ends = (from: number[], to: number[]) => ({ version: 2, endpoints: { from: from.map(uuid), to: to.map(uuid) } });
const types = [
  type(1, "Person", "node"), type(2, "Team", "node"),
  type(3, "Control", "node", { properties: [prop("threshold", "number"), prop("unit", "string"), prop("title", "string")] }),
  type(4, "Commitment", "node", { properties: [prop("state", "string")], ontology: { version: 2, stereotype: "relator", validity: "interval", participation: { slots: [
    { name: "owner", edgeTypeId: uuid(11), participantTypes: [uuid(1), uuid(2)], min: 1, max: 1 },
    { name: "control", edgeTypeId: uuid(12), participantTypes: [uuid(3)], min: 1, max: 1 },
  ] } } }),
  type(5, "Pairing", "node", { ontology: { version: 2, stereotype: "relator", participation: { slots: [
    { name: "member", edgeTypeId: uuid(16), participantTypes: [uuid(1)], min: 2, max: 2 }] } } }),
  type(16, "pair_member", "edge", { ontology: ends([5], [1]) }),
  type(17, "paired_with", "edge", { ontology: { version: 2, projection: { relatorTypeId: uuid(5), fromSlot: "member", toSlot: "member", symmetric: true } } }),
  type(11, "commitment_owner", "edge", { ontology: ends([4], [1, 2]) }),
  type(12, "implements_control", "edge", { ontology: ends([4], [3]) }),
  type(13, "reports_to", "edge", { ontology: ends([1], [1]), properties: [prop("status", "string"), prop("evidence", "string")] }),
  type(14, "mentions", "edge"),
  type(15, "Old", "node", { archived: true }),
];
const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const node = (n: number, typeId: number, title: string, extra: Record<string, unknown> = {}) =>
  ({ id: uuid(100 + n), typeId: uuid(typeId), slug: slugOf(title), title, summary: "", body: "", properties: {}, archived: false, revision: 1, updatedAt: 1_700_000_000_000, ...extra });
const edge = (n: number, typeId: number, from: number, to: number, extra: Record<string, unknown> = {}) =>
  ({ id: uuid(200 + n), typeId: uuid(typeId), fromId: uuid(100 + from), toId: uuid(100 + to), title: "", body: "", properties: {}, archived: false, revision: 1, updatedAt: 1, ...extra });
const snapshot = {
  installationId: "wiki-a", types,
  nodes: [
    node(1, 1, "Ada", { externalKey: "ai-outfitter.com/users:never-return" }), node(2, 1, "Grace"), node(3, 1, "Gone", { archived: true }),
    node(4, 2, "Platform"), node(5, 3, "Reviews", { properties: { threshold: 1, unit: "reviews", title: "shadowed" } }),
    node(6, 4, "Ada reviews", { validity: { from: "2026-01-01T00:00:00Z", to: null }, properties: { state: "active" } }),
    node(7, 4, "Team reviews", { properties: { state: "draft", valid_from: "2027-01-01T00:00:00Z" } }),
    node(8, 1, "Retired", { properties: { status: "retired" } }), node(9, 5, "Ada and Grace"),
  ],
  edges: [
    edge(1, 11, 6, 1), edge(2, 12, 6, 5), edge(3, 11, 7, 4), edge(4, 12, 7, 5),
    edge(5, 13, 2, 1, { properties: { status: "active", evidence: "org chart" }, validity: { from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" } }),
    edge(6, 13, 3, 1), edge(7, 13, 8, 1), edge(8, 14, 1, 4), edge(9, 16, 9, 1), edge(10, 16, 9, 2), edge(11, 13, 2, 1, { archived: true }),
  ],
};
const run = (query: string, extra: Partial<Parameters<typeof executeGraphQuery>[0]> = {}) =>
  executeGraphQuery({ types: types as TypeRow[], source: memorySource(snapshot), query, maxBytes: 65536, ...extra }).then(result => graphGraphqlResult.parse(result));

test("names are PascalCase types, camelCase fields and plural collections", () => {
  assert.equal(graphqlNames.typeName("reports_to"), "ReportsTo");
  assert.equal(graphqlNames.typeName("reports to"), "ReportsTo");
  assert.equal(graphqlNames.fieldName("ControlDefinition"), "controlDefinition");
  assert.equal(graphqlNames.collectionName("ControlDefinition"), "controlDefinitions");
  assert.equal(graphqlNames.collectionName("Status"), "status");
  assert.equal(graphqlNames.typeName("3d_model"), "T3dModel");
});

test("every node type serves validFrom/validUntil and takes at, so one document reads any Wiki", async () => {
  // Person declares no validity; a Wiki whose RoleAssignment predates `validity: "interval"` must still answer the viewer's document.
  const result = await run(`query($at: DateTime!) { persons(at: $at, first: 1) { nodes { title validFrom validUntil } } }`, { variables: { at: "2026-06-01T00:00:00Z" } });
  assert.deepEqual(result.errors, undefined);
  assert.deepEqual(result.data, { persons: { nodes: [{ title: "Ada", validFrom: null, validUntil: null }] } });
});

test("collections page in ID order with counts, typed properties and interval validity", async () => {
  const first = await run(`{ commitments(first: 1) { nodes { id title state validFrom validUntil } pageInfo { endCursor hasNextPage } totalCount } }`);
  assert.equal(first.errors, undefined);
  const page = (first.data as { commitments: { nodes: { id: string }[]; pageInfo: { endCursor: string; hasNextPage: boolean }; totalCount: number } }).commitments;
  assert.deepEqual(page.nodes, [{ id: uuid(106), title: "Ada reviews", state: "active", validFrom: "2026-01-01T00:00:00Z", validUntil: null }]);
  assert.deepEqual([page.pageInfo.hasNextPage, page.totalCount], [true, 2]);
  const next = await run(`query($after: String) { commitments(after: $after) { nodes { title validFrom } pageInfo { hasNextPage } } }`, { variables: { after: page.pageInfo.endCursor } });
  assert.deepEqual(next.data, { commitments: { nodes: [{ title: "Team reviews", validFrom: "2027-01-01T00:00:00Z" }], pageInfo: { hasNextPage: false } } });
  const at = await run(`{ commitments(at: "2026-06-01T00:00:00Z") { totalCount } control(id: "${uuid(105)}") { threshold unit title title_00000003 properties } __type(name: "Control") { name } }`);
  assert.deepEqual(at.data, { commitments: { totalCount: 1 }, control: { threshold: 1, unit: "reviews", title: "Reviews", title_00000003: "shadowed", properties: { threshold: 1, unit: "reviews", title: "shadowed" } }, __type: { name: "Control" } });
  assert.ok(((at.extensions?.naming ?? []) as { graphqlName: string }[]).some(warning => warning.graphqlName === "title_00000003"), "collisions are reported");
  const archived = await run(`{ only: persons(archived: ONLY) { nodes { title } } all: persons(archived: INCLUDE) { totalCount } persons { totalCount } }`);
  assert.deepEqual(archived.data, { only: { nodes: [{ title: "Gone" }] }, all: { totalCount: 4 }, persons: { totalCount: 3 } }, "collections hide archived, not retired, as graph.query does");
});

test("relator slots resolve participants and participants list their relators", async () => {
  const result = await run(`{
    commitment(id: "${uuid(106)}") { owner { __typename id title } control { title threshold } }
    control(id: "${uuid(105)}") { commitments(as: "control") { nodes { title owner { title } } totalCount } owners: commitments(as: "owner") { totalCount } }
    team(id: "${uuid(104)}") { commitments { nodes { title } } }
  }`);
  assert.equal(result.errors, undefined);
  assert.deepEqual(result.data, {
    commitment: { owner: { __typename: "Person", id: uuid(101), title: "Ada" }, control: { title: "Reviews", threshold: 1 } },
    control: { commitments: { nodes: [{ title: "Ada reviews", owner: { title: "Ada" } }, { title: "Team reviews", owner: { title: "Platform" } }], totalCount: 2 }, owners: { totalCount: 0 } },
    team: { commitments: { nodes: [{ title: "Team reviews" }] } },
  });
});

test("edge types give outgoing, incoming and edge-object fields; unconstrained edges go through edges()", async () => {
  const result = await run(`{
    person(id: "${uuid(101)}") {
      reportsToIncoming { nodes { title } }
      reportsToIncomingEdges { nodes { __typename status evidence validFrom from { title } } }
      during: reportsToIncoming(at: "2026-07-01T00:00:00Z") { nodes { title } }
      withArchived: reportsToIncoming(archived: INCLUDE) { nodes { title } totalCount }
      archivedEdges: reportsToIncomingEdges(archived: INCLUDE) { totalCount }
      archivedOnly: reportsToIncoming(archived: ONLY) { nodes { title } }
      edges(types: ["mentions"], direction: OUTGOING) { nodes { __typename typeId to { title } } edges { cursor node { id } } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } totalCount }
      none: edges(types: ["unknown"]) { nodes { id } totalCount }
      commitmentOwnerIncoming { nodes { title } }
    }
    grace: person(id: "${uuid(102)}") { reportsTo { nodes { title } } }
  }`);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  const nodes = (...titles: string[]) => ({ nodes: titles.map(title => ({ title })) });
  const mention = (result.data as { person: { edges: { edges: { cursor: string; node: { id: string } }[] } } }).person.edges.edges[0];
  assert.deepEqual(result.data, { person: {
    reportsToIncoming: nodes("Grace"),
    reportsToIncomingEdges: { nodes: [{ __typename: "ReportsTo", status: "active", evidence: "org chart", validFrom: "2026-01-01T00:00:00Z", from: { title: "Grace" } }] },
    during: nodes(), withArchived: { ...nodes("Grace", "Gone", "Retired"), totalCount: 3 }, archivedEdges: { totalCount: 4 }, archivedOnly: nodes("Grace"),
    // Edges of any type are a connection too: each record with its cursor, the page's ends, and a count.
    edges: { nodes: [{ __typename: "Mentions", typeId: uuid(14), to: { title: "Platform" } }], edges: [{ cursor: mention.cursor, node: { id: mention.node.id } }],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: mention.cursor, endCursor: mention.cursor }, totalCount: 1 },
    none: { nodes: [], totalCount: 0 },
    commitmentOwnerIncoming: nodes("Ada reviews"),
  }, grace: { reportsTo: nodes("Ada") } }, "archived and retired records are hidden by default; a node reached twice is listed once");
});

test("archived records by ID only when asked for; ids are bounded", async () => {
  const result = await run(`{ gone: node(id: "${uuid(103)}") { title } asked: person(id: "${uuid(103)}", archived: INCLUDE) { title } active: node(id: "${uuid(101)}") { title } }`);
  assert.deepEqual(result.data, { gone: null, asked: { title: "Gone" }, active: { title: "Ada" } });
  const many = await run(`query($ids: [ID!]) { persons(ids: $ids) { totalCount } }`, { variables: { ids: Array.from({ length: 201 }, (_, n) => uuid(n)) } });
  assert.equal(many.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
});

test("by-key roots take a slug, an ID or a node address, never both; collections filter by slug", async () => {
  const result = await run(`{
    addressed: node(id: "Person:ada") { slug }
    wrongAddress: node(id: "Control:ada") { slug }
    ada: person(slug: "ada") { id title reportsToIncoming { nodes { slug } } }
    any: node(slug: "reviews") { __typename slug }
    wrongType: team(slug: "ada") { title }
    missing: person(slug: "nobody") { title }
    gone: person(slug: "gone") { title }
    asked: person(slug: "gone", archived: INCLUDE) { title }
    persons(filter: { slug: { in: ["grace", "ada", "nobody"] } }) { nodes { slug } totalCount }
  }`);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.deepEqual(result.data, {
    addressed: { slug: "ada" }, wrongAddress: null,
    ada: { id: uuid(101), title: "Ada", reportsToIncoming: { nodes: [{ slug: "grace" }] } }, any: { __typename: "Control", slug: "reviews" },
    wrongType: null, missing: null, gone: null, asked: { title: "Gone" },
    persons: { nodes: [{ slug: "ada" }, { slug: "grace" }], totalCount: 2 },
  });
  const both = await run(`{ both: person(id: "${uuid(101)}", slug: "ada") { title } neither: node { title } }`);
  assert.deepEqual(both.data, { both: null, neither: null });
  assert.deepEqual(both.errors?.map(error => [error.path?.[0], error.extensions?.code]), [["both", "BAD_USER_INPUT"], ["neither", "BAD_USER_INPUT"]]);
  const many = await run(`query($slugs: [String!]) { persons(filter: { slug: { in: $slugs } }) { totalCount } }`, { variables: { slugs: Array.from({ length: 201 }, (_, n) => `s${n}`) } });
  assert.equal(many.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  assert.equal((await run(`{ persons(slugs: ["ada"]) { totalCount } }`)).errors?.[0]?.extensions?.code, "GRAPHQL_VALIDATION_FAILED", "the flat slugs argument is gone");
});

test("a relator slot over an edge type replaces that edge's target field", async () => {
  const fields = await run(`{ __type(name: "Pairing") { fields { name } } }`);
  const names = (fields.data as { __type: { fields: { name: string }[] } }).__type.fields.map(field => field.name);
  assert.ok(names.includes("member") && names.includes("pairMemberEdges") && !names.includes("pairMember") && !names.some(name => name.startsWith("member_")));
});

test("caller names are reserved: record fields, root fields and type names", async () => {
  const schemaOptions = { recordFields: { unit: { type: GraphQLString, resolve: () => "wiki-a" } }, rootFieldNames: ["persons"], typeNames: ["Team"] };
  const reserved = await run(`{ control(id: "${uuid(105)}") { unit unit_00000003 } persons_00000001 { totalCount } __type(name: "Team_00000002") { name } }`, { schemaOptions });
  assert.equal(reserved.errors, undefined, JSON.stringify(reserved.errors));
  assert.deepEqual(reserved.data, { control: { unit: "wiki-a", unit_00000003: "reviews" }, persons_00000001: { totalCount: 3 }, __type: { name: "Team_00000002" } });
  const clash = await run("{ node(id: \"x\") { id } }", { schemaOptions: { rootExtensions: () => ({ persons: { type: GraphQLString } }) } });
  assert.equal(clash.errors?.[0]?.extensions?.code, "SCHEMA_BUILD_FAILED");
  const twice = await run("{ node(id: \"x\") { id } }", { schemaOptions: { rootExtensions: { viewer: { type: new GraphQLObjectType({ name: "Person", fields: { id: { type: GraphQLString } } }) } } } });
  assert.equal(twice.errors?.[0]?.extensions?.code, "SCHEMA_BUILD_FAILED", "a duplicate type name is an error, not a throw");
});

test("projection edge types reach the other participants through the relator", async () => {
  const result = await run(`{ person(id: "${uuid(101)}") { pairedWith { nodes { title } totalCount } pairings(as: "member") { nodes { member { title } } } } }`);
  assert.deepEqual(result.data, { person: { pairedWith: { nodes: [{ title: "Grace" }], totalCount: 1 }, pairings: { nodes: [{ member: [{ title: "Ada" }, { title: "Grace" }] }] } } });
});

test("a connection that can match nothing asks no source, and every cursor names its order", async () => {
  const memory = memorySource(snapshot);
  const calls: string[] = [];
  const source: GraphSource = {
    ...memory,
    nodePage: query => { calls.push(`nodePage:${query.typeIds?.length}`); return memory.nodePage(query); },
    nodeCount: query => { calls.push("nodeCount"); return memory.nodeCount(query); },
    relationPage: query => { calls.push("relationPage"); return memory.relationPage(query); },
    relationCount: query => { calls.push("relationCount"); return memory.relationCount(query); },
  };
  const result = await executeGraphQuery({ types: types as TypeRow[], source, maxBytes: 65536,
    query: `{ search(text: "a", types: ["Nothing"]) { totalCount nodes { id } }
      commitments(first: 1) { edges { cursor node { id edges(types: ["nothing"]) { totalCount nodes { id } pageInfo { hasNextPage } } } } } }` });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  const data = JSON.parse(JSON.stringify(result.data)) as { search: unknown; commitments: { edges: { cursor: string; node: { id: string; edges: unknown } }[] } };
  assert.deepEqual(data.search, { totalCount: 0, nodes: [] });
  const [first] = data.commitments.edges;
  assert.deepEqual(first.node.edges, { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } });
  assert.deepEqual(calls, ["nodePage:1"], "only the collection that can hold records is read");
  assert.deepEqual(JSON.parse(decodeURIComponent(atob(first.cursor))), ["ID_ASC", first.node.id, first.node.id]);
});

test("resolvers batch source calls by level, not by record", async () => {
  const calls: string[] = [];
  const memory = memorySource(snapshot);
  const source: GraphSource = {
    ...memory,
    nodes: query => { calls.push(`nodes:${query.ids ? "ids" : "type"}`); return memory.nodes(query); },
    edges: query => { calls.push(`edges:${query.typeIds?.join(",")}:${query.fromIds ? "from" : "to"}`); return memory.edges(query); },
    nodePage: query => { calls.push(`nodePage:${query.first}`); return memory.nodePage(query); },
    relationPage: query => { calls.push(`relationPage:${query.parentIds.length}`); return memory.relationPage(query); },
    relationCount: query => { calls.push(`relationCount:${query.parentIds.length}`); return memory.relationCount(query); },
  };
  const result = await executeGraphQuery({ types: types as TypeRow[], source, maxBytes: 65536,
    query: `{ commitments { nodes { owner { title } control { title } commitmentOwnerEdges { nodes { id } totalCount } } } }` });
  assert.equal(result.errors, undefined);
  // One collection page, one edge read per (slot edge type, direction), one ID read for every participant,
  // and one relationship page and count for both commitments.
  assert.deepEqual(calls.sort(), ["edges:" + uuid(11) + ":from", "edges:" + uuid(11) + ":to", "edges:" + uuid(12) + ":from", "edges:" + uuid(12) + ":to", "nodePage:100", "nodes:ids",
    "relationCount:2", "relationPage:2"]);
});

test("relationship connections page each parent in order, read for every parent at once", async () => {
  // Three teams, each led by people created in a different order than their IDs.
  const leads = { ...snapshot, types: [...types, type(30, "leads", "edge", { ontology: ends([2], [1]) })],
    nodes: [...snapshot.nodes, ...[0, 1, 2].map(n => node(40 + n, 2, `Team ${n}`)),
      ...Array.from({ length: 9 }, (_, n) => node(50 + n, 1, `Lead ${n}`, { createdAt: 1_000 - n * 10 }))],
    edges: [...snapshot.edges, ...Array.from({ length: 9 }, (_, n) => edge(50 + n, 30, 40 + (n % 3), 50 + n))] };
  const relationPages: number[] = [];
  const memory = memorySource(leads);
  const source: GraphSource = { ...memory, relationPage: query => { relationPages.push(query.parentIds.length); return memory.relationPage(query); } };
  type LeadPage = { nodes: { title: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null }; totalCount?: number };
  const read = async (after: Record<string, string | null> = {}) => {
    const result = await executeGraphQuery({ types: leads.types as TypeRow[], source, maxBytes: 65536, variables: after,
      query: `query($a: String, $b: String, $c: String) {
        a: team(id: "${uuid(140)}") { leads(first: 2, orderBy: CREATED_AT_ASC, after: $a) { nodes { title } pageInfo { hasNextPage endCursor } totalCount } }
        b: team(id: "${uuid(141)}") { leads(first: 2, orderBy: CREATED_AT_ASC, after: $b) { nodes { title } pageInfo { hasNextPage endCursor } } }
        c: team(id: "${uuid(142)}") { leads(first: 2, orderBy: CREATED_AT_ASC, after: $c) { nodes { title } pageInfo { hasNextPage endCursor } } }
      }` });
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    return Object.fromEntries(Object.entries(result.data as Record<string, { leads: LeadPage }>).map(([key, value]) => [key, value.leads]));
  };
  const first = await read();
  const titles = (page: LeadPage) => page.nodes.map(item => item.title);
  // Team 0 leads 0, 3, 6 (created last to first: 6, 3, 0); team 1 leads 1, 4, 7; team 2 leads 2, 5, 8.
  assert.deepEqual([titles(first.a), titles(first.b), titles(first.c)], [["Lead 6", "Lead 3"], ["Lead 7", "Lead 4"], ["Lead 8", "Lead 5"]]);
  assert.ok([first.a, first.b, first.c].every(page => page.pageInfo.hasNextPage && page.pageInfo.endCursor));
  assert.equal(first.a.totalCount, 3);
  assert.deepEqual(relationPages, [3], "one page read answers all three teams");
  const next = await read({ a: first.a.pageInfo.endCursor, b: first.b.pageInfo.endCursor, c: first.c.pageInfo.endCursor });
  assert.deepEqual([titles(next.a), titles(next.b), titles(next.c)], [["Lead 0"], ["Lead 1"], ["Lead 2"]]);
  assert.ok([next.a, next.b, next.c].every(page => !page.pageInfo.hasNextPage));
  // A cursor continues only the order it was made with.
  const mixed = await executeGraphQuery({ types: leads.types as TypeRow[], source, maxBytes: 65536, variables: { after: first.a.pageInfo.endCursor },
    query: `query($after: String) { team(id: "${uuid(140)}") { leads(orderBy: TITLE_DESC, after: $after) { nodes { title } } } }` });
  assert.equal(mixed.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  const descending = await executeGraphQuery({ types: leads.types as TypeRow[], source, maxBytes: 65536,
    query: `{ team(id: "${uuid(140)}") { leads(orderBy: TITLE_DESC, first: 500) { nodes { title } } } persons(orderBy: CREATED_AT_DESC, first: 2) { nodes { title } } }` });
  assert.deepEqual(JSON.parse(JSON.stringify(descending.data)), { team: { leads: { nodes: [{ title: "Lead 6" }, { title: "Lead 3" }, { title: "Lead 0" }] } },
    persons: { nodes: [{ title: "Lead 0" }, { title: "Lead 1" }] } });
  const tooMany = await executeGraphQuery({ types: leads.types as TypeRow[], source, maxBytes: 65536, query: `{ team(id: "${uuid(140)}") { leads(first: 501) { nodes { title } } } }` });
  assert.equal(tooMany.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
});

test("node, search and privacy", async () => {
  const result = await run(`{ node(id: "${uuid(101)}") { __typename id ... on Person { properties body } } search(text: "reviews") { nodes { title typeId } } }`);
  assert.deepEqual(result.data, { node: { __typename: "Person", id: uuid(101), properties: {}, body: "" }, search: { nodes: [{ title: "Reviews", typeId: uuid(3) }, { title: "Ada reviews", typeId: uuid(4) }, { title: "Team reviews", typeId: uuid(4) }] } });
  const everything = await run(`{ persons(archived: INCLUDE) { nodes { id properties edges(archived: INCLUDE) { nodes { properties from { properties } } } } } }`);
  const text = JSON.stringify(everything);
  for (const secret of ["never-return", "externalKey"]) assert.ok(!text.includes(secret), secret);
  assert.equal((await run(`{ old(id: "${uuid(115)}") { id } }`)).errors?.[0]?.extensions?.code, "GRAPHQL_VALIDATION_FAILED", "archived types are not in the schema");
});

test("depth and field limits apply before execution; introspection is allowed", async () => {
  let reads = 0;
  const none = async () => { reads++; return []; };
  const source: GraphSource = { types: async () => types as TypeRow[], nodes: none, edges: none, nodePage: none, relationPage: none,
    nodeCount: async () => { reads++; return 0; }, relationCount: async () => { reads++; return new Map(); } };
  const deep = await executeGraphQuery({ types: types as TypeRow[], source, maxBytes: 65536, maxDepth: 3,
    query: `{ persons { nodes { reportsTo { nodes { title } } } } }` });
  assert.equal(deep.errors?.[0]?.extensions?.code, "QUERY_TOO_DEEP");
  const wide = await executeGraphQuery({ types: types as TypeRow[], source, maxBytes: 65536, maxFields: 5,
    query: `fragment F on Person { id title summary } { a: persons { nodes { ...F } } b: persons { nodes { ...F } } }` });
  assert.equal(wide.errors?.[0]?.extensions?.code, "QUERY_TOO_COMPLEX");
  assert.equal(reads, 0, "nothing ran");
  assert.equal((await run("{ persons {")).errors?.[0]?.extensions?.code, "GRAPHQL_PARSE_FAILED");
  const introspection = await run(getIntrospectionQuery(), { maxBytes: 262144 });
  assert.equal(introspection.errors, undefined);
});

type SearchPage = {
  nodes: { id: string; title?: string; body?: string; installationId?: string }[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
  totalCount: number;
};

test("search pages all matches past 100 with stable IDs, counts and no legacy list", async () => {
  const many = { ...snapshot, nodes: [
    ...Array.from({ length: 137 }, (_, n) => node(300 + n, n % 2 ? 1 : 2, `Roadmap evidence ${n}`)),
    node(999, 1, "Roadmap archived", { archived: true }),
  ] };
  const query = `query($after: String) { search(text: "roadmap", first: 40, after: $after) {
    nodes { id title } pageInfo { endCursor hasNextPage } totalCount
  } }`;
  const found: string[] = [];
  let after: string | null = null;
  for (let n = 0; n < 4; n++) {
    const result = await run(query, { source: memorySource(many), variables: { after } });
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    const page = (result.data as Record<string, SearchPage>).search;
    assert.equal(page.totalCount, 137);
    assert.equal(page.pageInfo.hasNextPage, n < 3);
    assert.ok(page.nodes.length > 0 && page.pageInfo.endCursor !== after);
    found.push(...page.nodes.map((item: { id: string }) => item.id));
    after = page.pageInfo.endCursor;
  }
  assert.equal(new Set(found).size, 137);
  assert.deepEqual(found, many.nodes.filter(row => !row.archived).map(row => row.id).sort());
  const legacy = await run(`{ search(text: "roadmap", first: 100) { id } }`, { source: memorySource(many) });
  assert.equal(legacy.errors?.[0]?.extensions?.code, "GRAPHQL_VALIDATION_FAILED", "search is the connection; the capped list and searchConnection are gone");
  assert.equal((await run(`{ searchConnection(text: "roadmap") { totalCount } }`)).errors?.[0]?.extensions?.code, "GRAPHQL_VALIDATION_FAILED");
  const terminal = await run(query, { source: memorySource(many), variables: { after } });
  assert.deepEqual((terminal.data as Record<string, SearchPage>).search, { nodes: [], pageInfo: { endCursor: null, hasNextPage: false }, totalCount: 137 });
  const filtered = await run(`{ search(text: "roadmap", types: ["Team"]) { totalCount } empty: search(text: "roadmap", types: ["Unknown"]) { nodes { id } totalCount } }`, { source: memorySource(many) });
  assert.equal((filtered.data as Record<string, SearchPage>).search.totalCount, 69);
  assert.deepEqual((filtered.data as Record<string, SearchPage>).empty, { nodes: [], totalCount: 0 });
  for (const args of ['text: " "', 'text: "roadmap", first: 501', 'text: "roadmap", first: -1', 'text: "roadmap", after: "%"']) {
    assert.equal((await run(`{ search(${args}) { nodes { id } } }`)).errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  }
});

test("byte-bounded search pages resume without gaps and preserve caller-owned names", async () => {
  const added = [...types, type(40, "SearchConnection", "node"), type(41, "search_connection", "node")];
  const many = { ...snapshot, types: added, nodes: Array.from({ length: 25 }, (_, n) => node(500 + n, 2, `Roadmap ${n}`, { body: "x".repeat(600) })) };
  const query = `query($after: String) { hits: search(text: "roadmap", first: 20, after: $after) {
    nodes { id body } more: pageInfo { endCursor hasNextPage } totalCount
  } }`;
  const found: string[] = [];
  let after: string | null = null;
  for (let n = 0; n < 30; n++) {
    const result = await run(query, { types: added as TypeRow[], source: memorySource(many), maxBytes: 4096, variables: { after } });
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    const page = (result.data as Record<string, Omit<SearchPage, "pageInfo"> & { more: SearchPage["pageInfo"] }>).hits;
    assert.ok(page.nodes.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
    assert.equal(page.totalCount, 25);
    found.push(...page.nodes.map((item: { id: string }) => item.id));
    if (!page.more.hasNextPage) break;
    assert.notEqual(page.more.endCursor, after);
    after = page.more.endCursor;
  }
  assert.equal(found.length, 25);
  assert.equal(new Set(found).size, 25);
});

test("search cursors retain compound Wiki keys when shown record IDs are shared", async () => {
  const shared = uuid(101);
  const composed = { ...snapshot, edges: [], nodes: [
    { ...node(1, 1, "Roadmap A"), id: `wiki-a\u001f${shared}` },
    { ...node(1, 1, "Roadmap B"), id: `wiki-b\u001f${shared}` },
  ] };
  const schemaOptions = { recordKeys: { shownId: (key: string) => key.split("\u001f")[1], find: async () => null },
    recordFields: { installationId: { type: GraphQLString, resolve: (row: GraphRow) => row.id.split("\u001f")[0] } } };
  const query = `query($after: String) { search(text: "roadmap", first: 1, after: $after) {
    nodes { id installationId } pageInfo { endCursor hasNextPage } totalCount
  } }`;
  const first = await run(query, { source: memorySource(composed), schemaOptions });
  assert.equal(first.errors, undefined);
  const page = (first.data as Record<string, SearchPage>).search;
  assert.deepEqual(page.nodes, [{ id: shared, installationId: "wiki-a" }]);
  assert.equal(page.totalCount, 2);
  assert.equal(page.pageInfo.hasNextPage, true);
  const next = await run(query, { source: memorySource(composed), schemaOptions, variables: { after: page.pageInfo.endCursor } });
  assert.equal(next.errors, undefined);
  assert.deepEqual((next.data as Record<string, SearchPage>).search.nodes, [{ id: shared, installationId: "wiki-b" }]);
  assert.equal((next.data as Record<string, SearchPage>).search.pageInfo.hasNextPage, false);
});

test("a type added at runtime appears in introspection on the next request", async () => {
  const query = `{ __type(name: "Incident") { fields { name } } }`;
  assert.deepEqual((await run(query)).data, { __type: null });
  const added = [...types, type(20, "Incident", "node", { properties: [prop("severity", "number")] })];
  const result = graphGraphqlResult.parse(await executeGraphQuery({ types: added as TypeRow[], source: memorySource({ ...snapshot, types: added }), query, maxBytes: 65536 }));
  const fields = (result.data as { __type: { fields: { name: string }[] } }).__type.fields.map(field => field.name);
  assert.ok(fields.includes("severity") && fields.includes("edges"));
  const sdl = await executeGraphQuery({ types: added as TypeRow[], source: memorySource({ ...snapshot, types: added }), query: "{ sdl }", maxBytes: 65536 });
  assert.match(String((sdl.data as { sdl: string }).sdl), /type Incident implements Node \{[^}]*severity: Float/);
});

test("responses over maxBytes cut lists, never records, and say where", async () => {
  const many = { ...snapshot, nodes: [...snapshot.nodes, ...Array.from({ length: 60 }, (_, n) => node(300 + n, 2, `Team ${n}`, { body: "b".repeat(400) }))] };
  const result = graphGraphqlResult.parse(await executeGraphQuery({ types: types as TypeRow[], source: memorySource(many), maxBytes: 8192,
    query: `{ teams { nodes { title body } page: pageInfo { endCursor hasNextPage } totalCount } }` }));
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= 8192);
  const teams = (result.data as { teams: { nodes: { body: string }[]; page: { endCursor: string; hasNextPage: boolean }; totalCount: number } }).teams;
  assert.ok(teams.nodes.length > 0 && teams.nodes.length < 61);
  assert.ok(teams.nodes.every(item => item.body === "" || item.body.length === 400));
  assert.equal(teams.totalCount, 61);
  assert.equal(teams.page.hasNextPage, true, "an aliased pageInfo is fixed too");
  assert.deepEqual(result.extensions?.truncatedPaths, [["teams", "nodes"]]);
  assert.equal(result.extensions?.truncated, true);
  const next = await executeGraphQuery({ types: types as TypeRow[], source: memorySource(many), maxBytes: 65536, variables: { after: teams.page.endCursor },
    query: `query($after: String) { teams(after: $after) { nodes { id } } }` });
  assert.equal((next.data as { teams: { nodes: unknown[] } }).teams.nodes.length, 61 - teams.nodes.length, "the cut page continues where it stopped");
});

test("a response that cannot be cut, or resolves too much, is refused, not returned oversized", async () => {
  const huge = { ...snapshot, nodes: [...snapshot.nodes, node(400, 2, "Huge", { body: "h".repeat(20_000) })] };
  const single = await executeGraphQuery({ types: types as TypeRow[], source: memorySource(huge), maxBytes: 8192, query: `{ team(id: "${uuid(500)}") { body } }` });
  assert.deepEqual([single.data, single.errors?.[0]?.extensions?.code], [null, "RESPONSE_TOO_LARGE"]);
  const many = { ...snapshot, nodes: [...snapshot.nodes, ...Array.from({ length: 500 }, (_, n) => node(1000 + n, 2, `Team ${n}`, { body: "b".repeat(400) }))] };
  const aliases = Array.from({ length: 1900 }, (_, n) => `a${n}: body`).join(" ");
  const started = Date.now();
  const exploded = await executeGraphQuery({ types: types as TypeRow[], source: memorySource(many), maxBytes: 65536, query: `{ teams(first: 500) { nodes { ${aliases} } } }` });
  assert.deepEqual([exploded.data, exploded.errors?.[0]?.extensions?.code], [null, "RESPONSE_TOO_LARGE"]);
  assert.ok(Date.now() - started < 3000, `stopped early (${Date.now() - started} ms)`);
});

test("input bounds", () => {
  assert.equal(graphGraphqlInput.parse({ query: "{ node(id: \"x\") { id } }" }).maxBytes, 65536);
  assert.throws(() => graphGraphqlInput.parse({ query: "" }));
  assert.throws(() => graphGraphqlInput.parse({ query: "{x}", maxBytes: 1_000_000 }));
  assert.throws(() => graphGraphqlInput.parse({ query: "{x}", extra: 1 }));
  assert.throws(() => graphGraphqlInput.parse({ query: "{x}", variables: { big: "v".repeat(40_000) } }));
});

test("naming warnings come with schema reads and with the renamed names a query uses, never with a plain data query", async () => {
  const plain = await run(`{ persons { totalCount } }`);
  assert.equal(plain.extensions, undefined);
  const renamed = await run(`{ control(id: "${uuid(105)}") { title_00000003 } }`);
  assert.deepEqual(((renamed.extensions?.naming ?? []) as { graphqlName: string }[]).map(warning => warning.graphqlName), ["title_00000003"]);
  const sdl = await run(`{ sdl }`);
  assert.ok(((sdl.extensions?.naming ?? []) as unknown[]).length >= 1);
});

test("record keys: a source keyed by more than the ID shows the ID and finds by-ID records through recordKeys", async () => {
  // Two copies of the graph, keyed "a/…" and "b/…", the way a schema composed over several graphs keys them.
  const keyed = (prefix: string) => ({
    nodes: snapshot.nodes.map(row => ({ ...row, id: `${prefix}/${row.id}`, graph: prefix })),
    edges: snapshot.edges.map(row => ({ ...row, id: `${prefix}/${row.id}`, fromId: `${prefix}/${row.fromId}`, toId: `${prefix}/${row.toId}` })),
  });
  const memory = memorySource({ installationId: "both", types, nodes: [...keyed("a").nodes, ...keyed("b").nodes], edges: [...keyed("a").edges, ...keyed("b").edges] });
  const shownId = (key: string) => key.slice(key.indexOf("/") + 1);
  const asked: string[][] = [];
  // Slugs are asked keyed too ("b/ada"): the source reads the plain slug and files each row under its graph's key as well.
  const source: GraphSource = { ...memory, nodes: query => { if (query.slugs) asked.push(query.slugs); return memory.nodes({ ...query, slugs: query.slugs?.map(shownId) }); },
    slugKey: row => `${row.graph}/${row.slug}` };
  const schemaOptions = { recordKeys: { shownId, args: { graph: { type: GraphQLString } },
    find: async (args: KeyArgs & Record<string, unknown>, context: GraphContext, keep: (row: GraphRow) => boolean) => {
      const row = args.slug ? (await context.loader.slug(`${args.graph ?? "a"}/${args.slug}`))[0] : await context.loader.node(`${args.graph ?? "a"}/${args.id}`);
      return row && keep(row) ? row : null;
    } } };
  const result = await executeGraphQuery({ types: types as TypeRow[], source, maxBytes: 65536, schemaOptions,
    query: `{ persons { nodes { id } totalCount } person(id: "${uuid(101)}", graph: "b") { id reportsToIncoming { nodes { title } } reportsToIncomingEdges { nodes { fromId toId } } }
      bySlug: person(slug: "ada", graph: "b") { id reportsToIncoming { nodes { title } } } }` });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  const data = JSON.parse(JSON.stringify(result.data)) as { persons: { nodes: { id: string }[]; totalCount: number };
    person: { id: string; reportsToIncoming: { nodes: unknown[] }; reportsToIncomingEdges: { nodes: { fromId: string; toId: string }[] } }; bySlug: unknown };
  assert.equal(data.persons.totalCount, 6, "both copies of every person");
  assert.equal(new Set(data.persons.nodes.map(row => row.id)).size, 3);
  assert.equal(data.person.id, uuid(101));
  assert.deepEqual(data.person.reportsToIncoming.nodes, [{ title: "Grace" }], "relationships stay inside their copy");
  assert.deepEqual(data.person.reportsToIncomingEdges.nodes, [{ fromId: uuid(102), toId: uuid(101) }]);
  assert.deepEqual(data.bySlug, { id: uuid(101), reportsToIncoming: { nodes: [{ title: "Grace" }] } });
  assert.deepEqual(asked, [["b/ada"]], "the keyed slug reaches the source, in one call");
});

test("connections follow the Relay spec: edges with cursors, four-field pageInfo, forward paging and totalCount", async () => {
  type Page = { edges: { cursor: string; node: { title: string } }[]; nodes: { title: string }[]; pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }; totalCount: number };
  const query = `query($after: String) { persons(first: 1, orderBy: TITLE_ASC, after: $after) { edges { cursor node { title } } nodes { title } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } totalCount } }`;
  const page = async (after: string | null) => ((await run(query, { variables: { after } })).data as { persons: Page }).persons;
  const first = await page(null);
  assert.deepEqual(first.nodes, [{ title: "Ada" }]);
  assert.deepEqual(first.edges.map(edge => edge.node), first.nodes, "edges hold the records nodes lists");
  assert.deepEqual(first.pageInfo, { hasNextPage: true, hasPreviousPage: false, startCursor: first.edges[0].cursor, endCursor: first.edges[0].cursor });
  assert.equal(first.totalCount, 3);
  // Any record's cursor continues after it, as endCursor does.
  const second = await page(first.edges[0].cursor);
  assert.deepEqual([second.nodes, second.pageInfo.hasPreviousPage, second.pageInfo.hasNextPage], [[{ title: "Grace" }], true, true]);
  const last = await page(second.pageInfo.endCursor);
  assert.deepEqual([last.nodes, last.pageInfo.hasPreviousPage, last.pageInfo.hasNextPage], [[{ title: "Retired" }], true, false]);
  const past = await page(last.pageInfo.endCursor);
  assert.deepEqual(past, { edges: [], nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: true, startCursor: null, endCursor: null }, totalCount: 3 });
  assert.equal((await run(`{ persons(first: -1) { nodes { id } } }`)).errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  const sdl = ((await run(`{ sdl }`)).data as { sdl: string }).sdl;
  assert.match(sdl, /type PersonConnection \{\s+edges: \[PersonConnectionEdge!\]!\s+nodes: \[Person!\]!\s+pageInfo: PageInfo!\s+totalCount: Int!\s+\}/);
  assert.match(sdl, /type PersonConnectionEdge \{\s+cursor: String!\s+node: Person!\s+\}/);
  assert.match(sdl, /type ReportsToConnectionEdge \{\s+cursor: String!\s+node: ReportsTo!\s+\}/);
  assert.match(sdl, /type EdgeConnection \{\s+edges: \[EdgeConnectionEdge!\]!\s+nodes: \[Edge!\]!/);
  assert.match(sdl, /type SearchConnectionEdge \{\s+cursor: String!\s+node: Node!\s+\}/);
  assert.match(sdl, /type PageInfo \{\s+hasNextPage: Boolean!\s+hasPreviousPage: Boolean!\s+startCursor: String\s+endCursor: String\s+\}/);
  assert.doesNotMatch(sdl, /aggregate|Aggregate|searchConnection|slugs:/);
});

test("filter takes connection-filter operators with and, or and not on collections, relationships and edges", async () => {
  const stamped = { ...snapshot, nodes: snapshot.nodes.map((row, index) => ({ ...row, createdAt: 1_800_000_000_000 + index * 1000 })) };
  const source = memorySource(stamped);
  const titles = async (filter: object, field = "persons", type = "PersonFilter", args = "archived: INCLUDE") => {
    const result = await run(`query($filter: ${type}) { ${field}(${args}, filter: $filter) { nodes { title } totalCount } }`, { source, variables: { filter } });
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    const page = (result.data as Record<string, { nodes: { title: string }[]; totalCount: number }>)[field];
    assert.equal(page.totalCount, page.nodes.length, "totalCount counts what the filter keeps");
    return page.nodes.map(row => row.title);
  };
  const at = (index: number) => new Date(1_800_000_000_000 + index * 1000).toISOString();
  assert.deepEqual(await titles({ slug: { equalTo: "ada" } }), ["Ada"]);
  assert.deepEqual(await titles({ slug: { notEqualTo: "ada" }, title: { lessThan: "H" } }), ["Grace", "Gone"]);
  assert.deepEqual(await titles({ id: { in: [uuid(102), uuid(108), uuid(104)] } }), ["Grace", "Retired"]);
  assert.deepEqual(await titles({ id: { notIn: [uuid(102)] }, title: { greaterThanOrEqualTo: "Gone" } }), ["Gone", "Retired"]);
  assert.deepEqual(await titles({ or: [{ title: { startsWith: "A" } }, { title: { includesInsensitive: "RETI" } }] }), ["Ada", "Retired"]);
  assert.deepEqual(await titles({ not: { title: { includes: "a" } } }), ["Gone", "Retired"], "includes is case-sensitive: Ada and Grace hold an a");
  assert.deepEqual(await titles({ title: { startsWithInsensitive: "g" }, and: [{ slug: { isNull: false } }, { not: { slug: { in: ["gone"] } } }] }), ["Grace"]);
  assert.deepEqual(await titles({ createdAt: { greaterThan: at(0), lessThanOrEqualTo: at(2) } }), ["Grace", "Gone"]);
  assert.deepEqual(await titles({ updatedAt: { equalTo: new Date(1_700_000_000_000).toISOString() }, title: { equalTo: "Ada" } }), ["Ada"]);
  assert.deepEqual(await titles({ slug: { isNull: true } }), []);
  // A relationship filters the records it lists: far nodes, or the edges of an …Edges field.
  const related = await run(`{ person(id: "${uuid(101)}") {
    reports: reportsToIncoming(archived: INCLUDE, filter: { title: { startsWith: "G" } }, orderBy: TITLE_DESC) { nodes { title } totalCount }
    edges: reportsToIncomingEdges(archived: INCLUDE, filter: { id: { in: ["${uuid(206)}", "${uuid(211)}"] } }) { nodes { id } totalCount }
    any: edges(filter: { id: { greaterThan: "${uuid(207)}" } }) { nodes { id } totalCount }
    commitments(filter: { title: { includes: "Ada" } }) { nodes { title } }
  } }`, { source });
  assert.equal(related.errors, undefined, JSON.stringify(related.errors));
  assert.deepEqual(related.data, { person: {
    reports: { nodes: [{ title: "Grace" }, { title: "Gone" }], totalCount: 2 },
    edges: { nodes: [{ id: uuid(206) }, { id: uuid(211) }], totalCount: 2 },
    any: { nodes: [{ id: uuid(208) }, { id: uuid(209) }], totalCount: 2 },
    commitments: { nodes: [{ title: "Ada reviews" }] },
  } });
  // Only the indexed fields, the named operators and a bounded size: the rest is refused before any read.
  const code = async (query: string, variables?: Record<string, unknown>) => (await run(query, { variables })).errors?.[0]?.extensions?.code;
  assert.equal(await code(`{ persons(filter: { body: { equalTo: "x" } }) { totalCount } }`), "GRAPHQL_VALIDATION_FAILED");
  assert.equal(await code(`{ persons(filter: { title: { like: "x" } }) { totalCount } }`), "GRAPHQL_VALIDATION_FAILED");
  assert.equal(await code(`{ person(id: "${uuid(101)}") { reportsToIncomingEdges(filter: { slug: { equalTo: "x" } }) { totalCount } } }`), "GRAPHQL_VALIDATION_FAILED", "edges have no slug");
  const wide = await run(`query($filter: PersonFilter) { persons(filter: $filter) { totalCount } }`, { variables: { filter: { or: Array.from({ length: 21 }, (_, n) => ({ slug: { equalTo: `s${n}` } })) } } });
  assert.equal(wide.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  assert.match(String(wide.errors?.[0]?.message), /21 conditions; at most 20 fit one database statement/);
  assert.equal(await code(`{ persons(filter: { createdAt: { lessThan: "NOW" } }) { totalCount } }`), undefined, "DateTime takes NOW");
});

test("projections page in the source: one relationship page per level, ordered, filtered and counted", async () => {
  // Three pairings: Ada with Grace, Ada with Gone (archived, so hidden) and Ada with Retired (retired, so hidden under EXCLUDE).
  const paired = { ...snapshot,
    nodes: [...snapshot.nodes, node(20, 5, "Ada and Platform lead"), node(21, 1, "Linus"), node(22, 5, "Ada and Linus"), node(23, 1, "Margaret"), node(24, 5, "Ada and Margaret")],
    edges: [...snapshot.edges, edge(20, 16, 22, 1), edge(21, 16, 22, 21), edge(22, 16, 24, 1), edge(23, 16, 24, 23), edge(24, 16, 20, 1)] };
  const calls: string[] = [];
  const inner = memorySource(paired);
  const source: GraphSource = { ...inner,
    edges: query => { calls.push("edges"); return inner.edges(query); },
    relationPage: query => { calls.push(`relationPage:${query.through ? "through" : "direct"}:${query.parentIds.length}`); return inner.relationPage(query); },
    relationCount: query => { calls.push(`relationCount:${query.through ? "through" : "direct"}`); return inner.relationCount(query); } };
  const result = await run(`{ persons(ids: ["${uuid(101)}", "${uuid(102)}"]) { nodes { title
    pairedWith(first: 2, orderBy: TITLE_DESC) { nodes { title } pageInfo { hasNextPage endCursor } totalCount }
    named: pairedWith(filter: { title: { in: ["Linus", "Ada"] } }) { nodes { title } }
  } } }`, { source });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  const [ada, grace] = (result.data as { persons: { nodes: { title: string; pairedWith: { nodes: { title: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string }; totalCount: number }; named: { nodes: { title: string }[] } }[] } }).persons.nodes;
  assert.deepEqual([ada.pairedWith.nodes, ada.pairedWith.pageInfo.hasNextPage, ada.pairedWith.totalCount], [[{ title: "Margaret" }, { title: "Linus" }], true, 3]);
  assert.deepEqual([grace.pairedWith.nodes, grace.pairedWith.totalCount, grace.named.nodes], [[{ title: "Ada" }], 1, [{ title: "Ada" }]]);
  assert.deepEqual(ada.named.nodes, [{ title: "Linus" }]);
  // Both people's pages come from one two-hop relationPage per field; nothing walks edges hop by hop.
  assert.deepEqual(calls.sort(), ["relationCount:through", "relationPage:through:2", "relationPage:through:2"]);
  const next = await run(`query($after: String) { person(id: "${uuid(101)}") { pairedWith(first: 2, orderBy: TITLE_DESC, after: $after) { nodes { title } pageInfo { hasNextPage hasPreviousPage } } } }`,
    { source, variables: { after: ada.pairedWith.pageInfo.endCursor } });
  assert.deepEqual(next.data, { person: { pairedWith: { nodes: [{ title: "Grace" }], pageInfo: { hasNextPage: false, hasPreviousPage: true } } } });
});

test("edge wrappers and filters are named last: they never rename a type, an order or a connection", async () => {
  const before = ((await run(`{ sdl }`)).data as { sdl: string }).sdl;
  // Types that want the generator's new names keep their own; the generated ones take the ID suffix instead.
  const taken = [...types, type(30, "PersonConnectionEdge", "node"), type(31, "PersonFilter", "node"), type(32, "NodeFilter", "node"), type(33, "StringFilter", "edge")];
  const result = await run(`{ sdl personConnectionEdges { nodes { id } } personFilters { nodes { id } } persons(filter: { slug: { equalTo: "ada" } }) { edges { node { title } } } }`, { types: taken as TypeRow[] });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  const sdl = (result.data as { sdl: string }).sdl;
  for (const name of ["type PersonConnectionEdge implements Node", "type PersonFilter implements Node", "type NodeFilter implements Node", "type StringFilter implements Edge",
    `type PersonConnectionEdge_${uuid(1).replaceAll("-", "").slice(-8)} {`, `input PersonFilter_${uuid(1).replaceAll("-", "").slice(-8)} {`]) assert.ok(sdl.includes(name), name);
  // Every name the schema had before is still there, unchanged.
  const names = (text: string) => [...text.matchAll(/^(?:type|input|enum|interface|scalar) (\w+)/gm)].map(match => match[1]);
  const kept = new Set(names(sdl));
  assert.deepEqual(names(before).filter(name => !kept.has(name) && !["NodeFilter", "StringFilter"].includes(name)), []);
  assert.deepEqual((result.data as { persons: unknown }).persons, { edges: [{ node: { title: "Ada" } }] });
});

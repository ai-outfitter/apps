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
  const first = await run(`{ commitments(first: 1) { nodes { id title state validFrom validUntil } pageInfo { endCursor hasNextPage } aggregate { count } } }`);
  assert.equal(first.errors, undefined);
  const page = (first.data as { commitments: { nodes: { id: string }[]; pageInfo: { endCursor: string; hasNextPage: boolean }; aggregate: { count: number } } }).commitments;
  assert.deepEqual(page.nodes, [{ id: uuid(106), title: "Ada reviews", state: "active", validFrom: "2026-01-01T00:00:00Z", validUntil: null }]);
  assert.deepEqual([page.pageInfo.hasNextPage, page.aggregate.count], [true, 2]);
  const next = await run(`query($after: String) { commitments(after: $after) { nodes { title validFrom } pageInfo { hasNextPage } } }`, { variables: { after: page.pageInfo.endCursor } });
  assert.deepEqual(next.data, { commitments: { nodes: [{ title: "Team reviews", validFrom: "2027-01-01T00:00:00Z" }], pageInfo: { hasNextPage: false } } });
  const at = await run(`{ commitments(at: "2026-06-01T00:00:00Z") { aggregate { count } } control(id: "${uuid(105)}") { threshold unit title title_00000003 properties } __type(name: "Control") { name } }`);
  assert.deepEqual(at.data, { commitments: { aggregate: { count: 1 } }, control: { threshold: 1, unit: "reviews", title: "Reviews", title_00000003: "shadowed", properties: { threshold: 1, unit: "reviews", title: "shadowed" } }, __type: { name: "Control" } });
  assert.ok(((at.extensions?.naming ?? []) as { graphqlName: string }[]).some(warning => warning.graphqlName === "title_00000003"), "collisions are reported");
  const archived = await run(`{ only: persons(archived: ONLY) { nodes { title } } all: persons(archived: INCLUDE) { aggregate { count } } persons { aggregate { count } } }`);
  assert.deepEqual(archived.data, { only: { nodes: [{ title: "Gone" }] }, all: { aggregate: { count: 4 } }, persons: { aggregate: { count: 3 } } }, "collections hide archived, not retired, as graph.query does");
});

test("relator slots resolve participants and participants list their relators", async () => {
  const result = await run(`{
    commitment(id: "${uuid(106)}") { owner { __typename id title } control { title threshold } }
    control(id: "${uuid(105)}") { commitments(as: "control") { nodes { title owner { title } } aggregate { count } } owners: commitments(as: "owner") { aggregate { count } } }
    team(id: "${uuid(104)}") { commitments { nodes { title } } }
  }`);
  assert.equal(result.errors, undefined);
  assert.deepEqual(result.data, {
    commitment: { owner: { __typename: "Person", id: uuid(101), title: "Ada" }, control: { title: "Reviews", threshold: 1 } },
    control: { commitments: { nodes: [{ title: "Ada reviews", owner: { title: "Ada" } }, { title: "Team reviews", owner: { title: "Platform" } }], aggregate: { count: 2 } }, owners: { aggregate: { count: 0 } } },
    team: { commitments: { nodes: [{ title: "Team reviews" }] } },
  });
});

test("edge types give outgoing, incoming and edge-object fields; unconstrained edges go through edges()", async () => {
  const result = await run(`{
    person(id: "${uuid(101)}") {
      reportsToIncoming { title }
      reportsToIncomingEdges { __typename status evidence validFrom from { title } }
      during: reportsToIncoming(at: "2026-07-01T00:00:00Z") { title }
      withArchived: reportsToIncoming(archived: INCLUDE) { title }
      archivedOnly: reportsToIncoming(archived: ONLY) { title }
      edges(types: ["mentions"], direction: OUTGOING) { __typename typeId to { title } }
      commitmentOwnerIncoming { title }
    }
    grace: person(id: "${uuid(102)}") { reportsTo { title } }
  }`);
  assert.equal(result.errors, undefined);
  assert.deepEqual(result.data, { person: {
    reportsToIncoming: [{ title: "Grace" }],
    reportsToIncomingEdges: [{ __typename: "ReportsTo", status: "active", evidence: "org chart", validFrom: "2026-01-01T00:00:00Z", from: { title: "Grace" } }],
    during: [], withArchived: [{ title: "Grace" }, { title: "Gone" }, { title: "Retired" }, { title: "Grace" }], archivedOnly: [{ title: "Grace" }],
    edges: [{ __typename: "Mentions", typeId: uuid(14), to: { title: "Platform" } }],
    commitmentOwnerIncoming: [{ title: "Ada reviews" }],
  }, grace: { reportsTo: [{ title: "Ada" }] } }, "archived and retired records are hidden by default");
});

test("archived records by ID only when asked for; ids are bounded", async () => {
  const result = await run(`{ gone: node(id: "${uuid(103)}") { title } asked: person(id: "${uuid(103)}", archived: INCLUDE) { title } active: node(id: "${uuid(101)}") { title } }`);
  assert.deepEqual(result.data, { gone: null, asked: { title: "Gone" }, active: { title: "Ada" } });
  const many = await run(`query($ids: [ID!]) { persons(ids: $ids) { aggregate { count } } }`, { variables: { ids: Array.from({ length: 201 }, (_, n) => uuid(n)) } });
  assert.equal(many.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
});

test("by-key roots take a slug or an ID, never both; collections filter by slugs", async () => {
  const result = await run(`{
    ada: person(slug: "ada") { id title reportsToIncoming { slug } }
    any: node(slug: "reviews") { __typename slug }
    wrongType: team(slug: "ada") { title }
    missing: person(slug: "nobody") { title }
    gone: person(slug: "gone") { title }
    asked: person(slug: "gone", archived: INCLUDE) { title }
    persons(slugs: ["grace", "ada", "nobody"]) { nodes { slug } aggregate { count } }
  }`);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.deepEqual(result.data, {
    ada: { id: uuid(101), title: "Ada", reportsToIncoming: [{ slug: "grace" }] }, any: { __typename: "Control", slug: "reviews" },
    wrongType: null, missing: null, gone: null, asked: { title: "Gone" },
    persons: { nodes: [{ slug: "ada" }, { slug: "grace" }], aggregate: { count: 2 } },
  });
  const both = await run(`{ both: person(id: "${uuid(101)}", slug: "ada") { title } neither: node { title } }`);
  assert.deepEqual(both.data, { both: null, neither: null });
  assert.deepEqual(both.errors?.map(error => [error.path?.[0], error.extensions?.code]), [["both", "BAD_USER_INPUT"], ["neither", "BAD_USER_INPUT"]]);
  const many = await run(`query($slugs: [String!]) { persons(slugs: $slugs) { aggregate { count } } }`, { variables: { slugs: Array.from({ length: 201 }, (_, n) => `s${n}`) } });
  assert.equal(many.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
});

test("a relator slot over an edge type replaces that edge's target field", async () => {
  const fields = await run(`{ __type(name: "Pairing") { fields { name } } }`);
  const names = (fields.data as { __type: { fields: { name: string }[] } }).__type.fields.map(field => field.name);
  assert.ok(names.includes("member") && names.includes("pairMemberEdges") && !names.includes("pairMember") && !names.some(name => name.startsWith("member_")));
});

test("caller names are reserved: record fields, root fields and type names", async () => {
  const schemaOptions = { recordFields: { unit: { type: GraphQLString, resolve: () => "wiki-a" } }, rootFieldNames: ["persons"], typeNames: ["Team"] };
  const reserved = await run(`{ control(id: "${uuid(105)}") { unit unit_00000003 } persons_00000001 { aggregate { count } } __type(name: "Team_00000002") { name } }`, { schemaOptions });
  assert.equal(reserved.errors, undefined, JSON.stringify(reserved.errors));
  assert.deepEqual(reserved.data, { control: { unit: "wiki-a", unit_00000003: "reviews" }, persons_00000001: { aggregate: { count: 3 } }, __type: { name: "Team_00000002" } });
  const clash = await run("{ node(id: \"x\") { id } }", { schemaOptions: { rootExtensions: () => ({ persons: { type: GraphQLString } }) } });
  assert.equal(clash.errors?.[0]?.extensions?.code, "SCHEMA_BUILD_FAILED");
  const twice = await run("{ node(id: \"x\") { id } }", { schemaOptions: { rootExtensions: { viewer: { type: new GraphQLObjectType({ name: "Person", fields: { id: { type: GraphQLString } } }) } } } });
  assert.equal(twice.errors?.[0]?.extensions?.code, "SCHEMA_BUILD_FAILED", "a duplicate type name is an error, not a throw");
});

test("projection edge types reach the other participants through the relator", async () => {
  const result = await run(`{ person(id: "${uuid(101)}") { pairedWith { title } pairings(as: "member") { nodes { member { title } } } } }`);
  assert.deepEqual(result.data, { person: { pairedWith: [{ title: "Grace" }], pairings: { nodes: [{ member: [{ title: "Ada" }, { title: "Grace" }] }] } } });
});

test("resolvers batch source calls by level, not by record", async () => {
  const calls: string[] = [];
  const memory = memorySource(snapshot);
  const source: GraphSource = {
    types: memory.types,
    nodes: query => { calls.push(`nodes:${query.ids ? "ids" : "type"}`); return memory.nodes(query); },
    edges: query => { calls.push(`edges:${query.typeIds?.join(",")}:${query.fromIds ? "from" : "to"}`); return memory.edges(query); },
  };
  const result = await executeGraphQuery({ types: types as TypeRow[], source, maxBytes: 65536,
    query: `{ commitments { nodes { owner { title } control { title } } } }` });
  assert.equal(result.errors, undefined);
  // One collection read, one edge read per (slot edge type, direction), one ID read for every participant.
  assert.deepEqual(calls.sort(), ["edges:" + uuid(11) + ":from", "edges:" + uuid(11) + ":to", "edges:" + uuid(12) + ":from", "edges:" + uuid(12) + ":to", "nodes:ids", "nodes:type"]);
});

test("node, search and privacy", async () => {
  const result = await run(`{ node(id: "${uuid(101)}") { __typename id ... on Person { properties body } } search(text: "reviews") { title typeId } }`);
  assert.deepEqual(result.data, { node: { __typename: "Person", id: uuid(101), properties: {}, body: "" }, search: [{ title: "Reviews", typeId: uuid(3) }, { title: "Ada reviews", typeId: uuid(4) }, { title: "Team reviews", typeId: uuid(4) }] });
  const everything = await run(`{ persons(archived: INCLUDE) { nodes { id properties edges(archived: INCLUDE) { properties from { properties } } } } }`);
  const text = JSON.stringify(everything);
  for (const secret of ["never-return", "externalKey"]) assert.ok(!text.includes(secret), secret);
  assert.equal((await run(`{ old(id: "${uuid(115)}") { id } }`)).errors?.[0]?.extensions?.code, "GRAPHQL_VALIDATION_FAILED", "archived types are not in the schema");
});

test("depth and field limits apply before execution; introspection is allowed", async () => {
  let reads = 0;
  const source: GraphSource = { types: async () => types as TypeRow[], nodes: async () => { reads++; return []; }, edges: async () => { reads++; return []; } };
  const deep = await executeGraphQuery({ types: types as TypeRow[], source, maxBytes: 65536, maxDepth: 3,
    query: `{ persons { nodes { reportsTo { reportsTo { title } } } } }` });
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
  aggregate: { count: number };
};

test("searchConnection pages all matches past 100 with stable IDs, counts and unchanged legacy search", async () => {
  const many = { ...snapshot, nodes: [
    ...Array.from({ length: 137 }, (_, n) => node(300 + n, n % 2 ? 1 : 2, `Roadmap evidence ${n}`)),
    node(999, 1, "Roadmap archived", { archived: true }),
  ] };
  const query = `query($after: String) { searchConnection(text: "roadmap", first: 40, after: $after) {
    nodes { id title } pageInfo { endCursor hasNextPage } aggregate { count }
  } }`;
  const found: string[] = [];
  let after: string | null = null;
  for (let n = 0; n < 4; n++) {
    const result = await run(query, { source: memorySource(many), variables: { after } });
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    const page = (result.data as Record<string, SearchPage>).searchConnection;
    assert.equal(page.aggregate.count, 137);
    assert.equal(page.pageInfo.hasNextPage, n < 3);
    assert.ok(page.nodes.length > 0 && page.pageInfo.endCursor !== after);
    found.push(...page.nodes.map((item: { id: string }) => item.id));
    after = page.pageInfo.endCursor;
  }
  assert.equal(new Set(found).size, 137);
  assert.deepEqual(found, many.nodes.filter(row => !row.archived).map(row => row.id).sort());
  const legacy = await run(`{ search(text: "roadmap", first: 100) { id } }`, { source: memorySource(many) });
  assert.equal((legacy.data as { search: { id: string }[] }).search.length, 100);
  const terminal = await run(query, { source: memorySource(many), variables: { after } });
  assert.deepEqual((terminal.data as Record<string, SearchPage>).searchConnection, { nodes: [], pageInfo: { endCursor: null, hasNextPage: false }, aggregate: { count: 137 } });
  const filtered = await run(`{ searchConnection(text: "roadmap", types: ["Team"]) { aggregate { count } } empty: searchConnection(text: "roadmap", types: ["Unknown"]) { nodes { id } aggregate { count } } }`, { source: memorySource(many) });
  assert.equal((filtered.data as Record<string, SearchPage>).searchConnection.aggregate.count, 69);
  assert.deepEqual((filtered.data as Record<string, SearchPage>).empty, { nodes: [], aggregate: { count: 0 } });
  for (const args of ['text: " "', 'text: "roadmap", first: 501', 'text: "roadmap", first: -1', 'text: "roadmap", after: "%"']) {
    assert.equal((await run(`{ searchConnection(${args}) { nodes { id } } }`)).errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  }
});

test("byte-bounded searchConnection pages resume without gaps and preserve caller-owned names", async () => {
  const added = [...types, type(40, "SearchConnection", "node"), type(41, "search_connection", "node")];
  const many = { ...snapshot, types: added, nodes: Array.from({ length: 25 }, (_, n) => node(500 + n, 2, `Roadmap ${n}`, { body: "x".repeat(600) })) };
  const query = `query($after: String) { hits: searchConnection(text: "roadmap", first: 20, after: $after) {
    nodes { id body } more: pageInfo { endCursor hasNextPage } aggregate { count }
  } }`;
  const found: string[] = [];
  let after: string | null = null;
  for (let n = 0; n < 30; n++) {
    const result = await run(query, { types: added as TypeRow[], source: memorySource(many), maxBytes: 4096, variables: { after } });
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    const page = (result.data as Record<string, Omit<SearchPage, "pageInfo"> & { more: SearchPage["pageInfo"] }>).hits;
    assert.ok(page.nodes.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
    assert.equal(page.aggregate.count, 25);
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
  const query = `query($after: String) { searchConnection(text: "roadmap", first: 1, after: $after) {
    nodes { id installationId } pageInfo { endCursor hasNextPage } aggregate { count }
  } }`;
  const first = await run(query, { source: memorySource(composed), schemaOptions });
  assert.equal(first.errors, undefined);
  const page = (first.data as Record<string, SearchPage>).searchConnection;
  assert.deepEqual(page.nodes, [{ id: shared, installationId: "wiki-a" }]);
  assert.equal(page.aggregate.count, 2);
  assert.equal(page.pageInfo.hasNextPage, true);
  const next = await run(query, { source: memorySource(composed), schemaOptions, variables: { after: page.pageInfo.endCursor } });
  assert.equal(next.errors, undefined);
  assert.deepEqual((next.data as Record<string, SearchPage>).searchConnection.nodes, [{ id: shared, installationId: "wiki-b" }]);
  assert.equal((next.data as Record<string, SearchPage>).searchConnection.pageInfo.hasNextPage, false);
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
    query: `{ teams { nodes { title body } page: pageInfo { endCursor hasNextPage } aggregate { count } } }` }));
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= 8192);
  const teams = (result.data as { teams: { nodes: { body: string }[]; page: { endCursor: string; hasNextPage: boolean }; aggregate: { count: number } } }).teams;
  assert.ok(teams.nodes.length > 0 && teams.nodes.length < 61);
  assert.ok(teams.nodes.every(item => item.body === "" || item.body.length === 400));
  assert.equal(teams.aggregate.count, 61);
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
  const plain = await run(`{ persons { aggregate { count } } }`);
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
    query: `{ persons { nodes { id } aggregate { count } } person(id: "${uuid(101)}", graph: "b") { id reportsToIncoming { title } reportsToIncomingEdges { fromId toId } }
      bySlug: person(slug: "ada", graph: "b") { id reportsToIncoming { title } } }` });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  const data = JSON.parse(JSON.stringify(result.data)) as { persons: { nodes: { id: string }[]; aggregate: { count: number } }; person: { id: string; reportsToIncoming: unknown[]; reportsToIncomingEdges: { fromId: string; toId: string }[] }; bySlug: unknown };
  assert.equal(data.persons.aggregate.count, 6, "both copies of every person");
  assert.equal(new Set(data.persons.nodes.map(row => row.id)).size, 3);
  assert.equal(data.person.id, uuid(101));
  assert.deepEqual(data.person.reportsToIncoming, [{ title: "Grace" }], "relationships stay inside their copy");
  assert.deepEqual(data.person.reportsToIncomingEdges, [{ fromId: uuid(102), toId: uuid(101) }]);
  assert.deepEqual(data.bySlug, { id: uuid(101), reportsToIncoming: [{ title: "Grace" }] });
  assert.deepEqual(asked, [["b/ada"]], "the keyed slug reaches the source, in one call");
});

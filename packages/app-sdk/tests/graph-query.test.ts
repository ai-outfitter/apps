import assert from "node:assert/strict";
import test from "node:test";
import { graphQueryInput, graphQueryResult, queryGraph } from "../src/graph-query";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const type = (n: number, name: string, category: "node" | "edge", extra: Record<string, unknown> = {}) =>
  ({ id: uuid(n), name, category, title: name, body: `About ${name}.`, properties: [], archived: false, revision: 1, ...extra });
const types = [
  type(1, "Role", "node", { jsonSchema: { type: "object" } }), type(2, "Assignment", "node"), type(3, "Person", "node"), type(4, "Org", "node"),
  type(5, "assigns_role", "edge", { ontology: { version: 1, endpoints: { from: [uuid(2)], to: [uuid(1)] } } }), type(6, "assigned_to", "edge"), type(7, "scoped_to", "edge"),
];
const node = (n: number, typeId: number, title: string, extra: Record<string, unknown> = {}) =>
  ({ id: uuid(100 + n), typeId: uuid(typeId), slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title, summary: "", body: "x".repeat(400), properties: {}, archived: false, revision: 2, updatedAt: 10, ...extra });
const edge = (n: number, typeId: number, from: number, to: number, extra: Record<string, unknown> = {}) =>
  ({ id: uuid(200 + n), typeId: uuid(typeId), fromId: uuid(100 + from), toId: uuid(100 + to), title: "", body: "", properties: {}, archived: false, revision: 1, updatedAt: 10, ...extra });
const snapshot = {
  installationId: "wiki-a", types,
  nodes: [node(1, 1, "CEO"), node(2, 1, "CTO"), node(3, 2, "CEO assignment"), node(4, 3, "Ada"), node(5, 4, "Acme"), node(6, 3, "Old", { archived: true })],
  edges: [edge(1, 5, 3, 1), edge(2, 6, 3, 4), edge(3, 7, 3, 5), edge(4, 6, 3, 6)],
};

test("batched queries return deduplicated compact records with expansion, endpoints and type signatures", async () => {
  const result = graphQueryResult.parse(await queryGraph(snapshot, { queries: [
    { name: "assignments", types: ["Assignment"], expand: { edgeTypes: ["assigns_role", "assigned_to", "scoped_to"] } },
    { name: "role_edges", entity: "edge", types: ["assigns_role"] },
  ] }));
  const assignments = result.queries.assignments;
  assert.deepEqual(assignments.matches, [uuid(103)]);
  assert.deepEqual(assignments.related, [uuid(101), uuid(104), uuid(105), uuid(201), uuid(202), uuid(203)]);
  assert.equal(assignments.complete, true);
  assert.equal(assignments.cursor, null);
  // The archived holder is neither traversed nor counted.
  assert.ok(!result.nodes.some(record => record.id === uuid(106)));
  assert.deepEqual(result.queries.role_edges.related, [uuid(101), uuid(103)], "edge matches resolve both endpoints");
  assert.equal(new Set(result.nodes.map(record => record.id)).size, result.nodes.length);
  assert.ok(result.nodes.every(record => !("body" in record)), "compact projection omits bodies");
  const role = result.types.find(record => record.name === "Role");
  assert.ok(role);
  assert.match(String(role.contractHash), /^[0-9a-f]{24}$/);
  assert.ok(role.bodySchemaHash);
  assert.deepEqual(result.types.find(record => record.name === "assigns_role")?.ontology, { version: 1, endpoints: { from: [uuid(2)], to: [uuid(1)] } });
  assert.equal(result.complete, true);
});

test("node queries match exact slugs, with the other filters", async () => {
  const result = await queryGraph(snapshot, { queries: [
    { name: "named", slugs: ["ceo", "ada", "nobody"] },
    { name: "typed", slugs: ["ceo", "ada"], types: ["Role"] },
    { name: "archived", slugs: ["old"], archived: "include", fields: ["slug"] },
  ] });
  assert.deepEqual([result.queries.named.matches, result.queries.named.total], [[uuid(101), uuid(104)], 2]);
  assert.deepEqual(result.queries.typed.matches, [uuid(101)]);
  assert.deepEqual(result.nodes.find(row => row.id === uuid(106))?.slug, "old");
  assert.throws(() => graphQueryInput.parse({ queries: [{ name: "e", entity: "edge", slugs: ["ceo"] }] }), /Only node queries filter by slug/);
});

test("contract hashes ignore documentation; doc hashes do not", async () => {
  const signature = async (overrides: Record<string, unknown>) => {
    const changed = { ...snapshot, types: snapshot.types.map(record => record.name === "Role" ? { ...record, ...overrides } : record) };
    return (await queryGraph(changed, { queries: [{ name: "t", entity: "type", types: ["Role"] }] })).types[0];
  };
  const base = await signature({});
  const reworded = await signature({ body: "Different words.", revision: 5 });
  const reshaped = await signature({ jsonSchema: { type: "object", required: ["x"] } });
  assert.equal(reworded.contractHash, base.contractHash);
  assert.notEqual(reworded.docHash, base.docHash);
  assert.notEqual(reshaped.contractHash, base.contractHash);
});

test("counts group by entity kind and type", async () => {
  const result = await queryGraph(snapshot, { queries: [{ name: "inventory", entity: "all", aggregate: "type" }] });
  const counts = result.queries.inventory.counts ?? [];
  assert.deepEqual(counts.find(row => row.entity === "node" && row.typeName === "Role")?.count, 2);
  assert.deepEqual(counts.find(row => row.entity === "node" && row.typeName === "Person")?.count, 1, "archived excluded by default");
  assert.deepEqual(counts.find(row => row.entity === "type" && row.typeName === "edge")?.count, 3);
  assert.equal(result.queries.inventory.total, 5 + 4 + 7, "active records of every kind");
  assert.deepEqual(result.nodes, []);
});

test("byte budgets page with cursors that resume exactly and reject other filters", async () => {
  const many = { ...snapshot, nodes: Array.from({ length: 120 }, (_, n) => node(n + 1, 3, `Person ${n}`, { summary: "s".repeat(300) })) };
  const query = { name: "people", types: ["Person"], limit: 500 };
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const result = await queryGraph(many, { queries: [{ ...query, ...(cursor ? { cursor } : {}) }], maxBytes: 8 * 1024 });
    assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= 8 * 1024 + 1024);
    assert.equal(result.queries.people.total, 120);
    seen.push(...result.queries.people.matches);
    cursor = result.queries.people.cursor ?? undefined;
    assert.equal(result.complete, !cursor);
    pages++;
  } while (cursor && pages < 50);
  assert.ok(pages > 1);
  assert.deepEqual(seen, many.nodes.map(record => record.id));
  const first = await queryGraph(many, { queries: [query], maxBytes: 8 * 1024 });
  await assert.rejects(queryGraph(many, { queries: [{ ...query, types: ["Role"], cursor: String(first.queries.people.cursor) }] }), (error: Response) => error.status === 400);
  await assert.rejects(queryGraph(many, { queries: [{ ...query, cursor: "garbage" }] }), (error: Response) => error.status === 400);
});

test("later queries keep their place when an earlier one spends the budget", async () => {
  const many = { ...snapshot, nodes: Array.from({ length: 60 }, (_, n) => node(n + 1, 3, `Person ${n}`, { summary: "s".repeat(300) })) };
  const result = await queryGraph(many, { maxBytes: 8 * 1024, queries: [{ name: "people", types: ["Person"] }, { name: "later", types: ["Person"] }] });
  assert.equal(result.queries.later.matches.length, 0);
  assert.ok(result.queries.later.cursor);
  const resumed = await queryGraph(many, { maxBytes: 64 * 1024, queries: [{ name: "later", types: ["Person"], cursor: String(result.queries.later.cursor) }] });
  assert.equal(resumed.queries.later.matches.length, 60);
});

test("full fields, field lists, archived filters, text and missing types", async () => {
  const full = await queryGraph(snapshot, { queries: [{ name: "q", ids: [uuid(101)], fields: "full" }] });
  assert.equal(full.nodes[0].body, "x".repeat(400));
  const picked = await queryGraph(snapshot, { queries: [{ name: "q", ids: [uuid(101)], fields: ["title"] }] });
  assert.deepEqual(Object.keys(picked.nodes[0]).sort(), ["id", "revision", "title", "typeId"]);
  const archived = await queryGraph(snapshot, { queries: [{ name: "q", archived: "only" }] });
  assert.deepEqual(archived.queries.q.matches, [uuid(106)]);
  const text = await queryGraph(snapshot, { queries: [{ name: "q", text: "acme" }] });
  assert.deepEqual(text.queries.q.matches, [uuid(105)]);
  const missing = await queryGraph(snapshot, { queries: [{ name: "q", types: ["Nope"], expand: { edgeTypes: ["nope_edge"] } }] });
  assert.deepEqual(missing.queries.q.missingTypes, ["Nope", "nope_edge"]);
  assert.equal(missing.queries.q.total, 0);
});

test("input rules", () => {
  assert.equal(graphQueryInput.safeParse({ queries: [{ name: "a" }, { name: "a" }] }).success, false);
  assert.equal(graphQueryInput.safeParse({ queries: [{ name: "a", entity: "all" }] }).success, false);
  assert.equal(graphQueryInput.safeParse({ queries: [{ name: "a", entity: "edge", expand: { edgeTypes: ["x"] } }] }).success, false);
  assert.equal(graphQueryInput.safeParse({ queries: [{ name: "a" }], maxBytes: 1024 * 1024 }).success, false);
});

test("review fixes: cursors stay on their Wiki, missing root types skip expansion, archived edge types are reported, hard ceiling holds", async () => {
  const first = await queryGraph(snapshot, { queries: [{ name: "q", types: ["Role"], limit: 1 }] });
  await assert.rejects(queryGraph({ ...snapshot, installationId: "wiki-b" }, { queries: [{ name: "q", types: ["Role"], limit: 1, cursor: String(first.queries.q.cursor) }] }), (error: Response) => error.status === 400);
  const dangling = { ...snapshot, nodes: [...snapshot.nodes, node(9, 99, "Typeless")] };
  const skipped = await queryGraph(dangling, { queries: [{ name: "q", ids: [uuid(109)], expand: { edgeTypes: ["assigned_to"] } }] });
  assert.deepEqual(skipped.queries.q.matches, [uuid(109)]);
  const archivedEdge = { ...snapshot, types: snapshot.types.map(record => record.name === "scoped_to" ? { ...record, archived: true } : record) };
  const reported = await queryGraph(archivedEdge, { queries: [{ name: "q", types: ["Assignment"], expand: { edgeTypes: ["scoped_to"] } }] });
  assert.deepEqual(reported.queries.q.missingTypes, ["scoped_to (archived)"]);
  const huge = { ...snapshot, nodes: [node(1, 2, "Hub"), ...Array.from({ length: 400 }, (_, n) => node(n + 10, 3, `P${n}`, { body: "b".repeat(2000) }))],
    edges: Array.from({ length: 400 }, (_, n) => edge(n + 1, 6, 1, n + 10)) };
  await assert.rejects(queryGraph(huge, { maxBytes: 8192, queries: [{ name: "q", ids: [uuid(101)], fields: "full", expand: { edgeTypes: ["assigned_to"], maxNodes: 500 } }] }), (error: Response) => error.status === 413);
});

test("expansion stays fast on a large graph and stops at the per-request root bound", async () => {
  const people = 5000;
  const large = { ...snapshot, nodes: Array.from({ length: people }, (_, n) => node(n + 1, 3, `P${n}`, { body: `# Person ${n}\n\nMarkdown body.` })),
    edges: Array.from({ length: people * 4 }, (_, n) => edge(n + 1, 6, (n % people) + 1, ((n * 7) % people) + 1)) };
  const started = performance.now();
  const result = await queryGraph(large, { maxBytes: 256 * 1024, queries: [{ name: "q", types: ["Person"], limit: 500, expand: { edgeTypes: ["assigned_to"], maxNodes: 2 } }] });
  const elapsed = performance.now() - started;
  assert.ok(result.queries.q.matches.length <= 100);
  assert.ok(result.queries.q.cursor);
  assert.ok(elapsed < 10_000, `took ${Math.round(elapsed)} ms`);
  console.log(`expanded ${result.queries.q.matches.length} roots on ${people} nodes in ${Math.round(elapsed)} ms`);
});

test("edge queries filter by the nodes they touch", async () => {
  const touching = (direction?: "outgoing" | "incoming" | "both") => queryGraph(snapshot, { queries: [{ name: "q", entity: "edge", touching: { nodeIds: [uuid(101)], ...(direction ? { direction } : {}) } }] });
  assert.deepEqual((await touching()).queries.q.matches, [uuid(201)]);
  assert.deepEqual((await touching("incoming")).queries.q.matches, [uuid(201)]);
  assert.deepEqual((await touching("outgoing")).queries.q.matches, []);
  assert.equal(graphQueryInput.safeParse({ queries: [{ name: "q", touching: { nodeIds: ["x"] } }] }).success, false);
});

test("expansion takes the selection a KnowledgeGraph saves, inline or by saved ID", async () => {
  const selection = { rootTypes: ["Assignment"], relationships: ["assigns_role", { type: "assigned_to", direction: "outgoing" as const }], maxDepth: 1, maxNodes: 50 };
  const inline = await queryGraph(snapshot, { queries: [{ name: "a", types: ["Assignment"], expand: selection }] });
  assert.deepEqual(inline.queries.a.related, [uuid(101), uuid(104), uuid(201), uuid(202)]);
  const resolved: string[] = [];
  const saved = await queryGraph(snapshot, { queries: [{ name: "a", types: ["Assignment"], expand: { knowledgeGraphId: "kg-1", maxNodes: 10 } }] }, {
    knowledgeGraph: id => { resolved.push(id); return { id: "wiki:kg-1", version: 1, purpose: "", terminalTypes: [], stopAtTypes: [], stopAfterTypes: [], ...selection }; },
  });
  assert.deepEqual(resolved, ["kg-1"]);
  assert.deepEqual(saved.queries.a.related, inline.queries.a.related);
  await assert.rejects(queryGraph(snapshot, { queries: [{ name: "a", expand: { knowledgeGraphId: "kg-1" } }] }), (error: unknown) => error instanceof Response && error.status === 400);
  // A root type the matched node doesn't have expands nothing.
  const other = await queryGraph(snapshot, { queries: [{ name: "a", types: ["Assignment"], expand: { ...selection, rootTypes: ["Role"] } }] });
  assert.deepEqual(other.queries.a.related, []);
});

test("compact and picked projections say a record is retired, wherever its status lives", async () => {
  const retired = { ...snapshot, nodes: [...snapshot.nodes, node(7, 1, "Former", { body: JSON.stringify({ status: "retired" }) }), node(8, 1, "Ex", { properties: { status: "retired" } })] };
  for (const fields of ["compact", ["title"]] as const) {
    const result = await queryGraph(retired, { queries: [{ name: "roles", types: ["Role"], fields: fields as never }] });
    assert.deepEqual(result.nodes.filter(record => record.retired).map(record => record.title), ["Former", "Ex"]);
  }
});

test("ordered pages: a collection in any order, a page per parent with its cursor, counts, and cursors bound to their order", async () => {
  // Three assignments, each with a role edge to a Role created in reverse of its ID order.
  const roles = [node(11, 1, "Role A", { createdAt: 30 }), node(12, 1, "Role B", { createdAt: 20 }), node(13, 1, "Role C", { createdAt: 10 })];
  const owners = [node(21, 2, "First"), node(22, 2, "Second"), node(23, 2, "Lonely")];
  const links = [edge(11, 5, 21, 11), edge(12, 5, 21, 12), edge(13, 5, 21, 13), edge(14, 5, 22, 12), edge(15, 5, 22, 12, { title: "twice" })];
  const graph = { ...snapshot, nodes: [...snapshot.nodes, ...roles, ...owners], edges: [...snapshot.edges, ...links] };
  const relation = { parentIds: [uuid(121), uuid(122), uuid(123)], edgeTypes: ["assigns_role"], direction: "outgoing" as const, targetTypes: ["Role"] };
  const result = graphQueryResult.parse(await queryGraph(graph, { includeTypes: "none", queries: [
    { name: "roles", types: ["Role"], ids: roles.map(row => row.id), orderBy: "CREATED_AT_ASC", limit: 2, count: true },
    { name: "held", relation, orderBy: "CREATED_AT_ASC", limit: 2, count: true },
    { name: "links", entity: "edge", relation, orderBy: "ID_DESC", limit: 1 },
  ] }));
  const { roles: page, held, links: edges } = result.queries;
  assert.deepEqual([page.matches, page.total, page.complete], [[uuid(113), uuid(112)], 3, false]);
  assert.deepEqual(held.parents?.map(parent => [parent.parentId, parent.rows.map(row => row.nodeId), parent.hasNextPage, parent.count]), [
    [uuid(121), [uuid(113), uuid(112)], true, 3],
    // A far node reached by two edges is listed once, through its lowest edge ID.
    [uuid(122), [uuid(112)], false, 1],
    [uuid(123), [], false, 0],
  ]);
  assert.deepEqual(held.parents?.[1].rows, [{ edgeId: uuid(214), nodeId: uuid(112) }]);
  assert.deepEqual(edges.parents?.map(parent => parent.rows.map(row => row.edgeId)), [[uuid(213)], [uuid(215)], []]);
  assert.equal(held.total, 4);
  assert.equal(edges.total, null, "no count asked");
  assert.ok(result.edges.some(row => row.id === uuid(214)) && result.nodes.some(row => row.id === uuid(112)), "rows carry their edge and far node");

  // Each parent continues from its own cursor; the next page starts after it.
  const next = await queryGraph(graph, { queries: [
    { name: "held", relation: { ...relation, parentIds: [uuid(121)] }, orderBy: "CREATED_AT_ASC", limit: 2, cursor: held.parents?.[0].cursor ?? undefined },
    { name: "roles", types: ["Role"], ids: roles.map(row => row.id), orderBy: "CREATED_AT_ASC", limit: 2, cursor: page.cursor ?? undefined },
  ] });
  assert.deepEqual(next.queries.held.parents?.map(parent => [parent.rows.map(row => row.nodeId), parent.hasNextPage]), [[[uuid(111)], false]]);
  assert.deepEqual([next.queries.roles.matches, next.queries.roles.complete], [[uuid(111)], true]);

  // A cursor continues only its order; limit 0 counts without reading rows.
  await assert.rejects(queryGraph(graph, { queries: [{ name: "held", relation, orderBy: "TITLE_ASC", cursor: held.parents?.[0].cursor ?? undefined }] }),
    (error: Response) => error.status === 400);
  const counted = await queryGraph(graph, { queries: [{ name: "held", relation, limit: 0, count: true }] });
  assert.deepEqual(counted.queries.held.parents?.map(parent => [parent.rows.length, parent.count, parent.hasNextPage]), [[0, 3, true], [0, 1, true], [0, 0, false]]);
  assert.throws(() => graphQueryInput.parse({ queries: [{ name: "q", relation, expand: { edgeTypes: ["assigns_role"] } }] }), /Ordered pages take no expand/);
  assert.throws(() => graphQueryInput.parse({ queries: [{ name: "q", types: ["Role"], count: true }] }), /Only ordered pages/);
  assert.throws(() => graphQueryInput.parse({ queries: [{ name: "q", entity: "edge", orderBy: "ID_ASC" }] }), /ordered collection page lists entity/);
});

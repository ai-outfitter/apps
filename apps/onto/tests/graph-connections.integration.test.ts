// Relationship connections over D1: products' revisions, first N per product in createdAt order,
// read for every product in a constant number of bounded statements, never a whole type.
import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { executeGraphQuery, graphGraphqlResult, memorySource, type TypeRow } from "@ai-outfitter/app-sdk/graph-graphql";
import { drizzle } from "drizzle-orm/d1";
import { readGraph } from "../src/server/graph";
import { databaseSource } from "../src/server/graph-source";
import { queryGraphRecords } from "../src/server/graph-query";
import { graphQueryResult } from "@ai-outfitter/app-sdk/graph-query";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const products = 8, revisions = 5;
type D1Database = Parameters<typeof drizzle>[0];
type D1PreparedStatement = ReturnType<D1Database["prepare"]>;

/** The D1 binding, logging every statement it prepares and the rows each returned. */
function counted(database: D1Database) {
  type Entry = { sql: string; values: unknown[]; rows: number };
  const log: Entry[] = [];
  const watch = (statement: D1PreparedStatement, entry: Entry): D1PreparedStatement => new Proxy(statement, {
    get(target, key) {
      if (key === "bind") return (...values: unknown[]) => { entry.values = values; return watch(target.bind(...values), entry); };
      if (key === "all") return async () => { const result = await target.all(); entry.rows += result.results.length; return result; };
      if (key === "raw") return async (options?: { columnNames?: boolean }) => {
        const result = await target.raw(options as never) as unknown[];
        entry.rows += result.length;
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const wrapped = new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => { const entry: Entry = { sql, values: [], rows: 0 }; log.push(entry); return watch(target.prepare(sql), entry); };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: drizzle(wrapped), log };
}

test("products' revisions page per product in one bounded relationship statement, whatever the number of products", async () => {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"));
  try {
    assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
    const call = async (action: string, input: object) => {
      const response = await app.call("/api/internal/actions/v1/call", owner, { method: "POST", body: { action, input } });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const create = (ref: string, type: string, attributes: object) => ({ operation: "create", ref, type, attributes });
    // The owner's shape: a product type whose `revisions` relationship reaches its revisions.
    const created = await call("graph.apply", { requestKey: "connection-types", operations: [
      create("$product", "graph-type", { category: "node", name: "Gadget", title: "Gadgets", body: "Synthetic." }),
      create("$revision", "graph-type", { category: "node", name: "GadgetRevision", title: "Gadget revisions", body: "Synthetic." }),
      create("$revisions", "graph-type", { category: "edge", ontology: { version: 2, endpoints: { from: "any", to: "any" } }, name: "revisions", title: "Revisions", body: "Synthetic." }),
    ] }) as Record<string, { id: string }>;
    await call("graph.apply", { requestKey: "connection-endpoints", operations: [{ operation: "update", ref: "$revisions", type: "graph-type", id: created.$revisions.id, revision: 1,
      attributes: { ontology: { version: 1, endpoints: { from: [created.$product.id], to: [created.$revision.id] } } } }] });
    const productIds = Array.from({ length: products }, () => crypto.randomUUID());
    const revisionIds = productIds.map(() => Array.from({ length: revisions }, () => crypto.randomUUID()));
    await call("graph.apply", { requestKey: "connection-records", operations: [
      ...productIds.map((id, p) => create(`$p${p}`, "graph-node", { id, typeId: created.$product.id, title: `Product ${p}` })),
      ...revisionIds.flatMap((ids, p) => ids.flatMap((id, r) => [
        create(`$r${p}_${r}`, "graph-node", { id, typeId: created.$revision.id, title: `Product ${p} revision ${r}` }),
        create(`$e${p}_${r}`, "graph-edge", { typeId: created.$revisions.id, fromId: productIds[p], toId: id }),
      ])),
    ] });
    // Revision r of each product was written r-th, whatever its ID.
    for (const [p, ids] of revisionIds.entries()) for (const [r, id] of ids.entries())
      await app.database.prepare("UPDATE graph_nodes SET createdAt=? WHERE id=?").bind(1_800_000_000_000 + p * 100 + r, id).run();

    const { db, log } = counted(app.database);
    const types = await databaseSource(db).types() as unknown as TypeRow[];
    const query = `query($ids: [ID!], $after: String) { gadgets(ids: $ids) { nodes { id
      revisions(first: 2, orderBy: CREATED_AT_ASC, after: $after) { nodes { id title } pageInfo { hasNextPage endCursor } totalCount } } } }`;
    type Page = { nodes: { id: string; title: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null }; totalCount: number };
    const read = async (ids: string[], after: string | null = null) => {
      log.length = 0;
      const result = graphGraphqlResult.parse(await executeGraphQuery({ types, source: databaseSource(db), query, variables: { ids, after }, maxBytes: 262144 }));
      assert.equal(result.errors, undefined, JSON.stringify(result.errors));
      const pages = new Map((result.data as { gadgets: { nodes: { id: string; revisions: Page }[] } }).gadgets.nodes.map(node => [node.id, node.revisions]));
      return { pages, statements: log.map(entry => ({ ...entry })) };
    };

    const few = await read(productIds.slice(0, 3)), all = await read(productIds);
    for (const [p, id] of productIds.entries()) {
      const page = all.pages.get(id) as Page;
      assert.deepEqual(page.nodes.map(node => node.title), [`Product ${p} revision 0`, `Product ${p} revision 1`]);
      assert.equal(page.pageInfo.hasNextPage, true);
      assert.equal(page.totalCount, revisions);
    }
    // A products page, one relationship page and one count, for three products as for eight.
    assert.equal(all.statements.length, few.statements.length, JSON.stringify(all.statements.map(entry => entry.sql)));
    assert.ok(all.statements.length <= 3, `${all.statements.length} statements`);
    // Every statement is bounded: a LIMIT or the parents' edges; none reads a whole type.
    for (const { sql, values } of all.statements) {
      assert.match(sql, /LIMIT|e\."(fromId|toId)" IN \(SELECT value FROM json_each/i, sql);
      // The plan agrees: no table scan, and a relationship reaches its nodes by ID, never through a type index.
      const plan = (await app.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all<{ detail: string }>()).results.map(row => row.detail);
      assert.ok(plan.length && !plan.some(step => /^SCAN (n|e|graph_nodes|graph_edges)\b/.test(step)), plan.join("\n"));
      if (/ROW_NUMBER|GROUP BY parent/.test(sql)) assert.ok(!plan.some(step => /graph_nodes_type_/.test(step)), plan.join("\n"));
    }
    const pageRows = all.statements.find(entry => /ROW_NUMBER/.test(entry.sql));
    assert.equal(pageRows?.rows, products * 3, "first + 1 revisions per product, from one statement");
    console.log(`statements: ${few.statements.length} for 3 products, ${all.statements.length} for ${products}; rows: ${all.statements.map(entry => entry.rows).join(", ")}`);

    // The owner's document: one product's revisions, continued after the first page.
    const second = await read([productIds[4]], (all.pages.get(productIds[4]) as Page).pageInfo.endCursor);
    assert.deepEqual((second.pages.get(productIds[4]) as Page).nodes.map(node => node.title), ["Product 4 revision 2", "Product 4 revision 3"]);
    const one = await executeGraphQuery({ types, source: databaseSource(db), maxBytes: 65536, variables: { productId: productIds[2] },
      query: `query($productId: ID) { gadget(id: $productId) { revisions(first: 10, orderBy: CREATED_AT_DESC) { nodes { id title } pageInfo { hasNextPage endCursor } } } }` });
    assert.equal(one.errors, undefined, JSON.stringify(one.errors));
    assert.deepEqual((one.data as { gadget: { revisions: Page } }).gadget.revisions.nodes.map(node => node.title), [4, 3, 2, 1, 0].map(r => `Product 2 revision ${r}`));

    // The same answers as memorySource over the whole-graph read.
    const graph = await readGraph(drizzle(app.database), { ...owner, installationId: "onto-installation", canEdit: true } as never);
    const variables = { ids: productIds, after: null };
    const expected = await executeGraphQuery({ types, source: memorySource({ installationId: "onto-installation", ...graph }), query, variables, maxBytes: 262144 });
    const actual = await executeGraphQuery({ types, source: databaseSource(db), query, variables, maxBytes: 262144 });
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));

    // graph.query's relation page: the same statements, for 3 products as for 8, and each product's own cursor.
    const identity = { ...owner, installationId: "onto-installation", canEdit: true } as never;
    const relation = (parentIds: string[]) => ({ parentIds, edgeTypes: ["revisions"], direction: "outgoing" as const, targetTypes: ["GadgetRevision"] });
    const graphQuery = async (parentIds: string[], cursor?: string) => {
      log.length = 0;
      const result = graphQueryResult.parse(await queryGraphRecords(db, identity, { includeTypes: "none", queries: [
        { name: "revisions", relation: relation(parentIds), orderBy: "CREATED_AT_ASC", limit: 2, count: true, fields: ["title"], ...(cursor ? { cursor } : {}) },
      ] }));
      return { result, statements: log.map(entry => ({ ...entry })) };
    };
    const threeParents = await graphQuery(productIds.slice(0, 3)), eightParents = await graphQuery(productIds);
    const parents = eightParents.result.queries.revisions.parents ?? [];
    const titles = new Map(eightParents.result.nodes.map(row => [row.id, row.title]));
    assert.deepEqual(parents.map(parent => [parent.rows.map(row => titles.get(row.nodeId)), parent.hasNextPage, parent.count]),
      productIds.map((_, p) => [[`Product ${p} revision 0`, `Product ${p} revision 1`], true, revisions]));
    // The types, one relationship page and one count, for three products as for eight.
    assert.equal(eightParents.statements.length, threeParents.statements.length, JSON.stringify(eightParents.statements.map(entry => entry.sql)));
    assert.equal(eightParents.statements.length, 3, JSON.stringify(eightParents.statements.map(entry => entry.sql)));
    for (const { sql, values } of eightParents.statements.filter(entry => !/from "graph_types"/i.test(entry.sql))) {
      assert.match(sql, /e\."fromId" IN \(SELECT value FROM json_each/i, sql);
      const plan = (await app.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all<{ detail: string }>()).results.map(row => row.detail);
      assert.ok(plan.length && !plan.some(step => /^SCAN (n|e|graph_nodes|graph_edges)\b/.test(step) || /graph_nodes_type_/.test(step)), plan.join("\n"));
    }
    assert.equal(eightParents.statements.find(entry => /ROW_NUMBER/.test(entry.sql))?.rows, products * 3, "limit + 1 revisions per product");
    console.log(`graph.query statements: ${threeParents.statements.length} for 3 products, ${eightParents.statements.length} for ${products}; rows: ${eightParents.statements.map(entry => entry.rows).join(", ")}`);
    // One product's next page from its own cursor reads only the rows after it.
    const continued = await graphQuery([productIds[4]], parents[4].cursor ?? undefined);
    const nextTitles = new Map(continued.result.nodes.map(row => [row.id, row.title]));
    assert.deepEqual(continued.result.queries.revisions.parents?.[0].rows.map(row => nextTitles.get(row.nodeId)), ["Product 4 revision 2", "Product 4 revision 3"]);
    assert.equal(continued.statements.find(entry => /ROW_NUMBER/.test(entry.sql))?.rows, 3);
    // A filtered, ordered relationship page and every node's edges of any type: still one statement each, whatever the number of products.
    const explain = async ({ sql, values }: { sql: string; values: unknown[] }) =>
      (await app.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all<{ detail: string }>()).results.map(row => row.detail);
    const scans = /^SCAN (n|r|e|e1|graph_nodes|graph_edges)\b/;
    const filteredQuery = `query($ids: [ID!]) { gadgets(ids: $ids) { nodes { id
      late: revisions(first: 2, orderBy: CREATED_AT_DESC, filter: { title: { includes: "revision" }, not: { title: { includesInsensitive: "REVISION 4" } }, createdAt: { greaterThan: "2000-01-01T00:00:00Z" }, or: [{ title: { startsWith: "Product" } }, { slug: { isNull: true } }] }) {
        edges { cursor node { title } } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } totalCount }
      links: edges(first: 3, orderBy: ID_ASC, direction: OUTGOING, filter: { createdAt: { lessThanOrEqualTo: "2999-01-01" } }) { nodes { id toId } pageInfo { hasNextPage } totalCount }
    } } }`;
    type Filtered = { id: string; late: { edges: { cursor: string; node: { title: string } }[]; pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string; endCursor: string }; totalCount: number };
      links: { nodes: { id: string; toId: string }[]; pageInfo: { hasNextPage: boolean }; totalCount: number } };
    const filtered = async (parentIds: string[]) => {
      log.length = 0;
      const result = graphGraphqlResult.parse(await executeGraphQuery({ types, source: databaseSource(db), query: filteredQuery, variables: { ids: parentIds }, maxBytes: 262144 }));
      assert.equal(result.errors, undefined, JSON.stringify(result.errors));
      return { nodes: (result.data as { gadgets: { nodes: Filtered[] } }).gadgets.nodes, statements: log.map(entry => ({ ...entry })) };
    };
    const fewFiltered = await filtered(productIds.slice(0, 3)), allFiltered = await filtered(productIds);
    for (const node of allFiltered.nodes) {
      const p = (productIds as string[]).indexOf(node.id);
      // Revision 4 is filtered out in SQL, so the newest two left are 3 and 2, of the 4 that pass.
      assert.deepEqual(node.late.edges.map(edge => edge.node.title), [`Product ${p} revision 3`, `Product ${p} revision 2`]);
      assert.deepEqual([node.late.pageInfo.hasNextPage, node.late.pageInfo.hasPreviousPage, node.late.totalCount], [true, false, revisions - 1]);
      assert.deepEqual([node.late.pageInfo.startCursor, node.late.pageInfo.endCursor], [node.late.edges[0].cursor, node.late.edges[1].cursor]);
      assert.deepEqual([node.links.nodes.length, node.links.pageInfo.hasNextPage, node.links.totalCount], [3, true, revisions]);
      assert.ok(node.links.nodes.every(edge => (revisionIds[p] as string[]).includes(edge.toId)));
    }
    // The products page, then a page and a count for each of the two connections: five statements for three products as for eight.
    assert.equal(allFiltered.statements.length, fewFiltered.statements.length, JSON.stringify(allFiltered.statements.map(entry => entry.sql)));
    assert.equal(allFiltered.statements.length, 5, JSON.stringify(allFiltered.statements.map(entry => entry.sql)));
    for (const statement of allFiltered.statements) {
      // Bounded by a LIMIT or by the parents' edges; the filter is in the statement, and it binds far fewer than D1's 100 parameters.
      assert.match(statement.sql, /LIMIT|e\."(fromId|toId)" IN \(SELECT value FROM json_each/i, statement.sql);
      assert.ok(statement.values.length <= 20, `${statement.values.length} parameters`);
      const plan = await explain(statement);
      assert.ok(plan.length && !plan.some(step => scans.test(step)), plan.join("\n"));
      if (/ROW_NUMBER|GROUP BY parent/.test(statement.sql)) {
        assert.match(statement.sql, /"f_(title|createdAt)"/, "the filter runs in the statement");
        assert.ok(plan.some(step => /graph_edges_(out|in)/.test(step)) && !plan.some(step => /graph_nodes_type_/.test(step)), plan.join("\n"));
      }
    }
    const relationPages = allFiltered.statements.filter(entry => /ROW_NUMBER/.test(entry.sql));
    assert.deepEqual(relationPages.map(entry => entry.rows).sort(), [products * 3, products * 4], "first + 1 rows per product from each page statement");
    console.log(`filtered relationship + Node.edges statements: ${fewFiltered.statements.length} for 3 products, ${allFiltered.statements.length} for ${products}; rows: ${allFiltered.statements.map(entry => entry.rows).join(", ")}; parameters: ${allFiltered.statements.map(entry => entry.values.length).join(", ")}`);
    // The next page of one product's filtered revisions continues from any edge's cursor.
    const after = await executeGraphQuery({ types, source: databaseSource(db), maxBytes: 65536, variables: { id: productIds[1], after: allFiltered.nodes.find(node => node.id === productIds[1])?.late.pageInfo.endCursor },
      query: `query($id: ID, $after: String) { gadget(id: $id) { revisions(first: 5, orderBy: CREATED_AT_DESC, after: $after, filter: { not: { title: { includesInsensitive: "REVISION 4" } } }) { nodes { title } pageInfo { hasNextPage hasPreviousPage } } } }` });
    assert.deepEqual(JSON.parse(JSON.stringify(after.data)), { gadget: { revisions: { nodes: [{ title: "Product 1 revision 1" }, { title: "Product 1 revision 0" }], pageInfo: { hasNextPage: false, hasPreviousPage: true } } } });
    // The same answers as memorySource, filters included.
    const filteredExpected = await executeGraphQuery({ types, source: memorySource({ installationId: "onto-installation", ...graph }), query: filteredQuery, variables: { ids: productIds }, maxBytes: 262144 });
    const filteredActual = await executeGraphQuery({ types, source: databaseSource(db), query: filteredQuery, variables: { ids: productIds }, maxBytes: 262144 });
    assert.deepEqual(JSON.parse(JSON.stringify(filteredActual)), JSON.parse(JSON.stringify(filteredExpected)));
    // A filtered collection page is one LIMIT statement answered by the type's index, never a scan.
    log.length = 0;
    const collection = await executeGraphQuery({ types, source: databaseSource(db), maxBytes: 65536,
      query: `{ gadgets(first: 3, orderBy: TITLE_ASC, filter: { title: { greaterThanOrEqualTo: "Product 2" }, slug: { notIn: ["nobody"] } }) { nodes { title } pageInfo { hasNextPage } totalCount } }` });
    assert.deepEqual(JSON.parse(JSON.stringify(collection.data)), { gadgets: { nodes: [2, 3, 4].map(p => ({ title: `Product ${p}` })), pageInfo: { hasNextPage: true }, totalCount: products - 2 } });
    assert.equal(log.length, 2, "the page and its count");
    for (const statement of log) {
      const plan = await explain(statement);
      assert.ok(plan.some(step => /SEARCH n USING (COVERING )?INDEX graph_nodes_type_/.test(step)) && !plan.some(step => scans.test(step)), plan.join("\n"));
    }
    // graph.query carries the same filter to the same statement.
    const filteredRelation = graphQueryResult.parse(await queryGraphRecords(db, identity, { includeTypes: "none", queries: [
      { name: "late", relation: relation(productIds), orderBy: "CREATED_AT_DESC", limit: 2, count: true, fields: ["title"], filter: { not: { title: { includesInsensitive: "REVISION 4" } } } },
    ] }));
    const filteredTitles = new Map(filteredRelation.nodes.map(row => [row.id, row.title]));
    assert.deepEqual(filteredRelation.queries.late.parents?.map(parent => [parent.rows.map(row => filteredTitles.get(row.nodeId)), parent.count]),
      productIds.map((_, p) => [[`Product ${p} revision 3`, `Product ${p} revision 2`], revisions - 1]));

    // An ordered collection page is one LIMIT statement.
    log.length = 0;
    const page = graphQueryResult.parse(await queryGraphRecords(db, identity, { includeTypes: "none", queries: [{ name: "gadgets", types: ["Gadget"], orderBy: "TITLE_DESC", limit: 3 }] }));
    assert.equal(page.queries.gadgets.matches.length, 3);
    assert.deepEqual(log.filter(entry => !/from "graph_types"/i.test(entry.sql)).map(entry => [/LIMIT/.test(entry.sql), entry.rows]), [[true, 4]]);
  } finally {
    await app.dispose();
  }
});

test("a projection through a relator pages, filters and counts in one statement each, whatever the number of parents", async () => {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"));
  try {
    assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
    const call = async (action: string, input: object) => {
      const response = await app.call("/api/internal/actions/v1/call", owner, { method: "POST", body: { action, input } });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const create = (ref: string, type: string, attributes: object) => ({ operation: "create", ref, type, attributes });
    const update = (ref: string, id: string, ontology: object) => ({ operation: "update", ref, type: "graph-type", id, revision: 1, attributes: { ontology } });
    // Gadgets pair up through a GadgetPairing relator; `paired_gadget` projects each gadget onto the others it is paired with.
    const made = await call("graph.apply", { requestKey: "projection-types", operations: [
      create("$gadget", "graph-type", { category: "node", name: "PairedGadget", title: "Paired gadgets", body: "Synthetic." }),
      create("$pairing", "graph-type", { category: "node", name: "GadgetPairing", title: "Gadget pairings", body: "Synthetic." }),
      create("$member", "graph-type", { category: "edge", ontology: { version: 2, endpoints: { from: "any", to: "any" } }, name: "pairing_member", title: "Pairing members", body: "Synthetic." }),
      create("$paired", "graph-type", { category: "edge", ontology: { version: 2, endpoints: { from: "any", to: "any" } }, name: "paired_gadget", title: "Paired gadgets", body: "Synthetic." }),
    ] }) as Record<string, { id: string }>;
    await call("graph.apply", { requestKey: "projection-ontology", operations: [
      update("$member", made.$member.id, { version: 2, endpoints: { from: [made.$pairing.id], to: [made.$gadget.id] } }),
      update("$pairing", made.$pairing.id, { version: 2, stereotype: "relator", participation: { slots: [{ name: "member", edgeTypeId: made.$member.id, participantTypes: [made.$gadget.id], min: 2, max: 2 }] } }),
      update("$paired", made.$paired.id, { version: 2, projection: { relatorTypeId: made.$pairing.id, fromSlot: "member", toSlot: "member", symmetric: true } }),
    ] });
    // Gadget 0 is paired with each of the other seven; each other gadget also with its next neighbour.
    const gadgetIds = Array.from({ length: products }, () => crypto.randomUUID());
    const pairs = [...gadgetIds.slice(1).map((_, n) => [0, n + 1]), ...gadgetIds.slice(1, -1).map((_, n) => [n + 1, n + 2])];
    await call("graph.apply", { requestKey: "projection-records", operations: [
      ...gadgetIds.map((id, g) => create(`$g${g}`, "graph-node", { id, typeId: made.$gadget.id, title: `Gadget ${g}` })),
      ...pairs.flatMap(([a, b], n) => {
        const id = crypto.randomUUID();
        return [create(`$pair${n}`, "graph-node", { id, typeId: made.$pairing.id, title: `Pair ${a}-${b}` }),
          create(`$a${n}`, "graph-edge", { typeId: made.$member.id, fromId: id, toId: gadgetIds[a] }),
          create(`$b${n}`, "graph-edge", { typeId: made.$member.id, fromId: id, toId: gadgetIds[b] })];
      }),
    ] });

    const { db, log } = counted(app.database);
    const types = await databaseSource(db).types() as unknown as TypeRow[];
    const query = `query($ids: [ID!]) { pairedGadgets(ids: $ids) { nodes { title
      pairedGadget(first: 2, orderBy: TITLE_DESC, filter: { title: { notEqualTo: "Gadget 7" } }) { nodes { title } pageInfo { hasNextPage } totalCount } } } }`;
    type Row = { title: string; pairedGadget: { nodes: { title: string }[]; pageInfo: { hasNextPage: boolean }; totalCount: number } };
    const read = async (ids: string[]) => {
      log.length = 0;
      const result = graphGraphqlResult.parse(await executeGraphQuery({ types, source: databaseSource(db), query, variables: { ids }, maxBytes: 262144 }));
      assert.equal(result.errors, undefined, JSON.stringify(result.errors));
      return { rows: (result.data as { pairedGadgets: { nodes: Row[] } }).pairedGadgets.nodes, statements: log.map(entry => ({ ...entry })) };
    };
    const few = await read(gadgetIds.slice(0, 3)), all = await read(gadgetIds);
    const byTitle = new Map(all.rows.map(row => [row.title, row.pairedGadget]));
    // Gadget 0 reaches the other seven, never itself; Gadget 7 is filtered out in SQL, leaving six.
    assert.deepEqual([byTitle.get("Gadget 0")?.nodes, byTitle.get("Gadget 0")?.pageInfo.hasNextPage, byTitle.get("Gadget 0")?.totalCount], [[{ title: "Gadget 6" }, { title: "Gadget 5" }], true, 6]);
    // Gadget 3 is paired with 0, 2 and 4.
    assert.deepEqual([byTitle.get("Gadget 3")?.nodes, byTitle.get("Gadget 3")?.pageInfo.hasNextPage, byTitle.get("Gadget 3")?.totalCount], [[{ title: "Gadget 4" }, { title: "Gadget 2" }], true, 3]);
    // The gadgets, one projection page and one count: three statements for three gadgets as for eight.
    assert.equal(all.statements.length, few.statements.length, JSON.stringify(all.statements.map(entry => entry.sql)));
    assert.equal(all.statements.length, 3, JSON.stringify(all.statements.map(entry => entry.sql)));
    for (const statement of all.statements) {
      assert.ok(statement.values.length <= 40, `${statement.values.length} parameters`);
      const plan = (await app.database.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.values).all<{ detail: string }>()).results.map(row => row.detail);
      assert.ok(plan.length && !plan.some(step => /^SCAN (n|r|e|e1|graph_nodes|graph_edges)\b/.test(step)), plan.join("\n"));
    }
    const pageStatement = all.statements.find(entry => /ROW_NUMBER/.test(entry.sql));
    assert.match(pageStatement?.sql ?? "", /"f_title"/, "the filter and the order run in the statement");
    // Five gadgets have three or more paired gadgets that pass (first + 1 rows each); gadgets 1, 6 and 7 have two.
    assert.equal(pageStatement?.rows, 5 * 3 + 3 * 2);
    console.log(`projection statements: ${few.statements.length} for 3 gadgets, ${all.statements.length} for ${products}; rows: ${all.statements.map(entry => entry.rows).join(", ")}; parameters: ${all.statements.map(entry => entry.values.length).join(", ")}`);
    // The same answers as memorySource over the whole-graph read.
    const graph = await readGraph(drizzle(app.database), { ...owner, installationId: "onto-installation", canEdit: true } as never);
    const expected = await executeGraphQuery({ types, source: memorySource({ installationId: "onto-installation", ...graph }), query, variables: { ids: gadgetIds }, maxBytes: 262144 });
    assert.deepEqual(JSON.parse(JSON.stringify({ pairedGadgets: { nodes: all.rows } })), JSON.parse(JSON.stringify(expected.data)));
    // graph.query carries the projection's first hop to the same statement.
    const through = graphQueryResult.parse(await queryGraphRecords(db, { ...owner, installationId: "onto-installation", canEdit: true } as never, { includeTypes: "none", queries: [
      { name: "paired", relation: { parentIds: [gadgetIds[0]], edgeTypes: ["pairing_member"], direction: "both", targetTypes: ["PairedGadget"], through: { edgeTypes: ["pairing_member"], nodeTypes: ["GadgetPairing"] } },
        orderBy: "TITLE_DESC", limit: 2, count: true, fields: ["title"], filter: { title: { notEqualTo: "Gadget 7" } } },
    ] }));
    const titles = new Map(through.nodes.map(row => [row.id, row.title]));
    assert.deepEqual(through.queries.paired.parents?.map(parent => [parent.rows.map(row => titles.get(row.nodeId)), parent.hasNextPage, parent.count]), [[["Gadget 6", "Gadget 5"], true, 6]]);
  } finally {
    await app.dispose();
  }
});

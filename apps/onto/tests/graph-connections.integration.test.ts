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

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const products = 8, revisions = 5;

/** The D1 binding, logging every statement it prepares and the rows each returned. */
function counted(database: D1Database) {
  const log: { sql: string; rows: number }[] = [];
  const watch = (statement: D1PreparedStatement, entry: { sql: string; rows: number }): D1PreparedStatement => new Proxy(statement, {
    get(target, key) {
      if (key === "bind") return (...values: unknown[]) => watch(target.bind(...values), entry);
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
      if (key === "prepare") return (sql: string) => { const entry = { sql, rows: 0 }; log.push(entry); return watch(target.prepare(sql), entry); };
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
      revisions(first: 2, orderBy: CREATED_AT_ASC, after: $after) { nodes { id title } pageInfo { hasNextPage endCursor } aggregate { count } } } } }`;
    type Page = { nodes: { id: string; title: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null }; aggregate: { count: number } };
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
      assert.equal(page.aggregate.count, revisions);
    }
    // A products page, one relationship page and one count, for three products as for eight.
    assert.equal(all.statements.length, few.statements.length, JSON.stringify(all.statements.map(entry => entry.sql)));
    assert.ok(all.statements.length <= 3, `${all.statements.length} statements`);
    // Every statement is bounded: a LIMIT or the parents' edges; none reads a whole type.
    for (const { sql } of all.statements) assert.match(sql, /LIMIT|e\."(fromId|toId)" IN \(SELECT value FROM json_each/i, sql);
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
  } finally {
    await app.dispose();
  }
});

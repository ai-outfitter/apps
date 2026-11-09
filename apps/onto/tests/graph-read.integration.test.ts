import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { wikiGraphReadResult } from "@ai-outfitter/app-sdk/graph-contracts";
import { core } from "../src/lib/graph";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const member = { ...owner, userId: "reader", role: "member" };
const path = "/api/internal/actions/v1/call";
test("snapshot reads preserve raw graph data and archival retains revision checks", async () => {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"));
  try {
    assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
    const create = (ref: string, type: string, attributes: object) => ({ operation: "create", ref, type, attributes });
    const response = await app.call(path, owner, { method: "POST", body: { action: "graph.apply", input: {
      requestKey: "graph-reader-fixture", operations: [
        create("$type", "graph-type", { category: "node", name: "ReaderEntity", title: "Reader entity", body: "Synthetic graph reader type." }),
        create("$relation", "graph-type", { category: "edge", ontology: { version: 2, endpoints: { from: "any", to: "any" } }, name: "reader_link", title: "Reader link", body: "A synthetic directed link." }),
        create("$root", "graph-node", { typeId: "$type", title: "Root", body: "Stored **Markdown** stays unchanged." }),
        create("$child", "graph-node", { typeId: "$type", title: "Child" }),
        create("$other", "graph-node", { typeId: "$type", title: "Unrelated" }),
        create("$edge", "graph-edge", { typeId: "$relation", fromId: "$root", toId: "$child" }),
        create("$cycle", "graph-edge", { typeId: "$relation", fromId: "$child", toId: "$root" }),
        create("$lens", "graph-node", { typeId: core.knowledgeGraph, title: "Reader lens", properties: {
          root_type: "ReaderEntity", pattern: JSON.stringify({ relationships: ["reader_link"], max_depth: 2 }),
        } }),
        create("$shared", "graph-node", { typeId: core.knowledgeGraph, title: "Shared context", properties: {
          root_type: "ReaderEntity", pattern: JSON.stringify({ relationships: ["reader_link"], max_depth: 2 }),
        }, body: JSON.stringify({
          name: "Shared context", purpose: "Read stored facts", rootTypes: ["KnowledgeGraph", "ReaderEntity", "MissingFeature"],
          selection: { relationships: ["reader_link"], maxDepth: 2, maxNodes: 1 },
        }) }),
      ],
    } } });
    assert.equal(response.status, 200, await response.clone().text());
    const ids = await response.json() as Record<string, { id: string }>;
    await app.database.prepare("UPDATE graph_nodes SET externalKey=? WHERE id=?").bind('ai-outfitter.com/users:never-return', ids.$root.id).run();
    const entitySearch = async (type: string, query: string, filter = {}) => {
      const response = await app.call("/api/internal/entities/v1/list", member, { method: "POST", body: { type, filter: { ...filter, query }, limit: 100 } });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<{ ref: { id: string } }[]>;
    };
    assert.deepEqual((await entitySearch("graph-node", "  MARKDOWN  ")).map(row => row.ref.id), [ids.$root.id]);
    assert.ok((await entitySearch("graph-type", "synthetic directed")).some(row => row.ref.id === ids.$relation.id));
    assert.ok((await entitySearch("graph-edge", ids.$root.id)).some(row => row.ref.id === ids.$edge.id));
    const edgeRow = (await entitySearch("graph-edge", ids.$root.id)).find(row => row.ref.id === ids.$edge.id) as { title?: string } | undefined;
    assert.equal(edgeRow?.title, "reader_link(ReaderEntity:root → ReaderEntity:child)", "an untitled edge is named by its address, not its UUID");
    assert.deepEqual(await entitySearch("graph-node", "never-return"), [], "external ids are neither searched nor returned");
    assert.deepEqual(await entitySearch("graph-node", "' OR 1=1 --"), []);
    assert.deepEqual(await entitySearch("graph-node", "%_"), []);
    assert.deepEqual(await entitySearch("graph-node", "markdown", { typeId: ids.$relation.id }), []);
    assert.ok((await entitySearch("graph-node", "")).some(row => row.ref.id === ids.$root.id));
    for (const [type, id] of [["graph-node", ids.$root.id], ["graph-edge", ids.$edge.id], ["graph-type", ids.$type.id]]) {
      assert.deepEqual((await entitySearch(type, "", { ids: [id] })).map(row => row.ref.id), [id]);
      assert.deepEqual(await entitySearch(type, "", { ids: ["missing-exact-id"] }), []);
    }
    const counts = () => app.database.prepare("SELECT 'nodes' AS kind, count(*) AS n, sum(revision) AS revisions FROM graph_nodes UNION ALL SELECT 'edges', count(*), sum(revision) FROM graph_edges UNION ALL SELECT 'types', count(*), sum(revision) FROM graph_types").all();
    const declaration = await app.call(path, member, {method:"POST",body:{action:"graph.describe",input:{}}});
    assert.equal(declaration.status,200);
    const advertised = await declaration.json() as {contracts:{id:string;version:number}[];capabilities:string[]};
    assert.ok(advertised.capabilities.every(capability => typeof capability === "string"));
    const before = await counts();
    const catalog = await app.call("/api/internal/actions/v1/list", member);
    assert.equal(catalog.status, 200);
    const descriptor = (await catalog.json() as { name: string; access: string; permitted: boolean; readOnly: boolean }[]).find(action => action.name === "graph.read");
    assert.deepEqual(descriptor && { access: descriptor.access, permitted: descriptor.permitted, readOnly: descriptor.readOnly }, { access: "read", permitted: true, readOnly: true });
    const read = (input: object) => app.call(path, member, { method: "POST", body: { action: "graph.read", input } });
    const whole = await read({});
    assert.equal(whole.status, 200, await whole.clone().text());
    const all = wikiGraphReadResult.parse(await whole.json());
    assert.ok(all.nodes.some(node => node.id === ids.$other.id));
    assert.equal(all.selection, null);
    assert.ok(!JSON.stringify(all).includes("never-return"));
    assert.deepEqual((await counts()).results, before.results);
    assert.equal((await read({ rootId: ids.$root.id, lensId: ids.$lens.id })).status, 400);
    assert.equal((await app.dispatch("", new Request(`${app.origin}${path}`, { method: "POST", body: JSON.stringify({ action: "graph.read", input: {} }) }))).status, 401);
    await app.database.prepare("UPDATE graph_types SET archived=1 WHERE id=?").bind(ids.$type.id).run();
    const withArchivedType = wikiGraphReadResult.parse(await (await read({})).json());
    assert.equal(withArchivedType.types.find(type => type.id === ids.$type.id)?.archived, true);
    await app.database.prepare("UPDATE graph_types SET archived=0 WHERE id=?").bind(ids.$type.id).run();
    await app.database.prepare("UPDATE graph_edges SET archived=1 WHERE id=?").bind(ids.$edge.id).run();
    const historical = wikiGraphReadResult.parse(await (await read({ includeArchivedEdges: true })).json());
    assert.ok(historical.edges.some(edge => edge.id === ids.$edge.id && edge.archived));
    const activeOnly = wikiGraphReadResult.parse(await (await read({})).json());
    assert.ok(!activeOnly.edges.some(edge => edge.id === ids.$edge.id));
    await app.database.prepare("UPDATE graph_edges SET archived=0 WHERE id=?").bind(ids.$edge.id).run();
    const canonical = await app.call("/api/internal/entities/v1/get", member, { method: "POST", body: { type: "graph-node", id: ids.$other.id } });
    assert.equal(canonical.status, 200);
    const current = await canonical.json() as { revision: number; references: unknown[] };
    const archiveInput = { type: "graph-node", id: ids.$other.id, revision: current.revision, references: current.references, attributes: { archived: true } };
    assert.equal((await app.call("/api/internal/entities/v1/update", member, { method: "POST", body: archiveInput })).status, 403);
    const archived = await app.call("/api/internal/entities/v1/update", owner, { method: "POST", body: archiveInput });
    assert.equal(archived.status, 200, await archived.clone().text());
    const archivedRecord = await archived.json() as { revision: number; attributes: { archived: boolean } };
    assert.equal(archivedRecord.attributes.archived, true);
    assert.deepEqual(await entitySearch("graph-node", "", { ids: [ids.$other.id], archived: false }), []);
    assert.equal((await entitySearch("graph-node", "", { ids: [ids.$other.id], archived: true })).length, 1);
    assert.equal((await app.call("/api/internal/entities/v1/update", owner, { method: "POST", body: archiveInput })).status, 409);
    const restored = await app.call("/api/internal/entities/v1/update", owner, { method: "POST", body: { ...archiveInput, revision: archivedRecord.revision, attributes: { archived: false } } });
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.equal((await entitySearch("graph-node", "", { ids: [ids.$other.id], archived: false })).length, 1);
    for (let i = 0; i < 30; i++) await app.database.prepare(
      "INSERT INTO graph_nodes(id,typeId,slug,title,body,createdAt,updatedAt) VALUES(?,?,?,?,?,1,1)",
    ).bind(crypto.randomUUID(), ids.$type.id, `large-${i}`, `Large ${i}`, "x".repeat(300000)).run();
    assert.equal((await read({})).status, 413);
  } finally { await app.dispose(); }
});

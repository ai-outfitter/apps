import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/d1";
import { restoreGraph } from "../src/server/graph-transfer";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { appWorker } from "./fixtures/initialized-worker";
import { core } from "../src/lib/graph";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
test("wiki transfer preserves IDs, is repeatable, rejects conflicts and denies members", async () => {
  const app = await appWorker(
    "wiki-map",
    new URL(
      "../.outfitter/packages/operational.json",
      import.meta.url,
    ),
  );
  const path = "/api/apps/wiki-map/graph/restore";
  const apply = async (transfer: unknown) => {
    const preview = await app.call("/api/apps/wiki-map/graph/preview", owner, { method: "POST", body: transfer });
    if (!preview.ok) return preview;
    const plan = await preview.json() as { previewToken: string };
    return app.call(path, owner, { method: "POST", body: { transfer, previewToken: plan.previewToken } });
  };
  const node = {
    id: "81000000-0000-4000-8000-000000000001",
    typeId: core.organization,
    slug: "transfer-org",
    title: "Transfer Org",
  };
  const file = {
    format: "outfitter-wiki-transfer-v1",
    types: [],
    nodes: [node],
    edges: [],
  };
  try {
    assert.equal(
      (
        await app.call(
          path,
          { ...owner, role: "member" },
          { method: "POST", body: { transfer: file, previewToken: "0".repeat(64) } },
        )
      ).status,
      403,
    );
    assert.equal((await app.call(path, owner, { method: "POST", body: file })).status, 400);
    let result = await apply(file);
    assert.equal(result.status, 200, await result.clone().text());
    assert.deepEqual((await result.json() as { added: unknown }).added, {
      types: 0, nodes: 1, edges: 0,
    });
    result = await apply(file);
    assert.equal(result.status, 200, await result.clone().text());
    assert.deepEqual((await result.json() as { added: unknown }).added, {
      types: 0, nodes: 0, edges: 0,
    });
    assert.equal(
      (
        await apply({ ...file, nodes: [{ ...node, title: "Changed" }] })
      ).status,
      409,
    );
    const invalid = {
      ...file,
      nodes: [
        {
          ...node,
          id: "81000000-0000-4000-8000-000000000002",
          slug: "must-not-exist",
        },
      ],
      edges: [
        {
          id: "82000000-0000-4000-8000-000000000001",
          typeId: core.uses,
          fromId: node.id,
          toId: "81000000-0000-4000-8000-000000000099",
        },
      ],
    };
    assert.equal(
      (await apply(invalid)).status,
      400,
    );
    const snapshot = (await (
      await app.call("/api/apps/wiki-map/graph/snapshot", owner)
    ).json()) as { nodes: { id: string }[] };
    assert.ok(snapshot.nodes.some((n) => n.id === node.id));
    assert.ok(!snapshot.nodes.some((n) => n.id === invalid.nodes[0].id));
  } finally {
    await app.dispose();
  }
});


test("archive state of types, nodes and relationships survives transfer", async () => {
  const app = await appWorker("wiki-map", new URL("../.outfitter/packages/operational.json", import.meta.url));
  const nodeType = "81000000-0000-4000-8000-000000000011", edgeType = "81000000-0000-4000-8000-000000000012";
  const from = "81000000-0000-4000-8000-000000000013", to = "81000000-0000-4000-8000-000000000014", edge = "81000000-0000-4000-8000-000000000015";
  const transfer = { format: "outfitter-wiki-transfer-v1", types: [
    { id: nodeType, category: "node", name: "ArchivedTransferNode", title: "Archived", body: "History", archived: true },
    { id: edgeType, category: "edge", name: "ArchivedTransferEdge", title: "Archived", body: "History", archived: true, ontology: { version: 2, endpoints: { from: "any", to: "any" } } },
  ], nodes: [
    { id: from, typeId: nodeType, slug: "archived-transfer-from", title: "Archived from", archived: true },
    { id: to, typeId: nodeType, slug: "archived-transfer-to", title: "Archived to", archived: true },
  ], edges: [{ id: edge, typeId: edgeType, fromId: from, toId: to, archived: true }] };
  try {
    const preview = await app.call("/api/apps/wiki-map/graph/preview", owner, { method: "POST", body: transfer });
    assert.equal(preview.status, 200, await preview.clone().text());
    const plan = await preview.json() as { previewToken: string };
    const restored = await app.call("/api/apps/wiki-map/graph/restore", owner, { method: "POST", body: { transfer, previewToken: plan.previewToken } });
    assert.equal(restored.status, 200, await restored.clone().text());
    const exported = await (await app.call("/api/apps/wiki-map/graph/export", owner)).json() as { transfer: { types: { id: string; archived: boolean }[]; nodes: { id: string; archived: boolean }[]; edges: { id: string; archived: boolean }[] } };
    assert.equal(exported.transfer.types.find(row => row.id === nodeType)?.archived, true);
    assert.equal(exported.transfer.nodes.find(row => row.id === from)?.archived, true);
    assert.equal(exported.transfer.edges.find(row => row.id === edge)?.archived, true);
  } finally { await app.dispose(); }
});


test("transfer preview rejects ontology-invalid relationships", async () => {
  const app = await appWorker(
    "wiki-map",
    new URL(
      "../.outfitter/packages/operational.json",
      import.meta.url,
    ),
  );
  const nodeType = crypto.randomUUID(),
    otherType = crypto.randomUUID(),
    edgeType = crypto.randomUUID(),
    first = crypto.randomUUID(),
    second = crypto.randomUUID();
  const transfer = {
    format: "outfitter-wiki-transfer-v1",
    types: [
      {
        id: nodeType,
        category: "node",
        name: "TransferPerson",
        title: "Person",
        body: "Person",
      },
      {
        id: otherType,
        category: "node",
        name: "TransferProduct",
        title: "Product",
        body: "Product",
      },
      {
        id: edgeType,
        category: "edge",
        name: "TransferUses",
        title: "uses",
        body: "Uses",
        ontology: {
          version: 1,
          endpoints: { from: [nodeType], to: [otherType] },
        },
      },
    ],
    nodes: [
      { id: first, typeId: nodeType, title: "Person", slug: "transfer-person" },
      {
        id: second,
        typeId: otherType,
        title: "Product",
        slug: "transfer-product",
      },
    ],
    edges: [
      {
        id: crypto.randomUUID(),
        typeId: edgeType,
        fromId: second,
        toId: first,
      },
    ],
  };
  try {
    const response = await app.call("/api/apps/wiki-map/graph/preview", owner, {
      method: "POST",
      body: transfer,
    });
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "ontology_validation_failed",
    );
  } finally {
    await app.dispose();
  }
});


test("a concurrent edit after import validation rejects the entire import", async () => {
  const app = await appWorker("wiki-map", new URL("../.outfitter/packages/operational.json", import.meta.url));
  const client = app.database;
  const original = client.batch.bind(client);
  const intercepted = {
    prepare: client.prepare.bind(client),
    batch: async (...args: Parameters<typeof original>) => {
      await client.prepare("UPDATE graph_types SET revision=revision+1 WHERE id=?").bind(core.entity).run();
      return original(...args);
    },
  };
  const db = drizzle(intercepted as unknown as Parameters<typeof drizzle>[0]);
  const who: AppIdentity = { ...owner, installationId: app.installationId, owner: { kind: "organization", id: "org" }, canEdit: true };
  const nodeId = crypto.randomUUID();
  const file = { format: "outfitter-wiki-transfer-v1", types: [], nodes: [{ id: nodeId, typeId: core.entity, title: "Concurrent import", slug: "concurrent-import" }], edges: [] };
  try {
    const preview = await restoreGraph(db, who, file, { preview: true });
    await assert.rejects(restoreGraph(db, who, file, { previewToken: preview.previewToken }), (error: unknown) => error instanceof Response && error.status === 409);
    assert.equal(await client.prepare("SELECT id FROM graph_nodes WHERE id=?").bind(nodeId).first(), null);
    assert.equal(await client.prepare("SELECT requestKey FROM graph_changes WHERE requestKey LIKE 'snapshot:%'").first(), null);
  } finally { await app.dispose(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import type { AppArchive } from "@ai-outfitter/app-sdk/data-transfer";
import { core } from "../src/lib/graph";

const pack = new URL("../.outfitter/packages/operational.json", import.meta.url);
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const prodId = "91000000-0000-4000-8000-0000000000a1";
const localId = "91000000-0000-4000-8000-0000000000b1";
const node = { id: "91000000-0000-4000-8000-000000000001", typeId: core.organization, slug: "archive-org", title: "Archive Org" };

async function exportAll(app: Awaited<ReturnType<typeof appWorker>>) {
  const pages: AppArchive[] = [];
  let cursor: string | null = null;
  do {
    const response = await app.call(`/api/outfitter/data/export${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, owner);
    assert.equal(response.status, 200, await response.clone().text());
    const page = await response.json() as AppArchive;
    pages.push(page);
    cursor = page.cursor;
  } while (cursor);
  return pages;
}

async function pull(local: Awaited<ReturnType<typeof appWorker>>, pages: AppArchive[]) {
  const map = { [prodId]: localId };
  for (const archive of pages) {
    const preview = await local.call("/api/outfitter/data/preview", owner, { method: "POST", body: { archive, map } });
    assert.equal(preview.status, 200, await preview.clone().text());
    const { previewToken } = await preview.json() as { previewToken: string };
    const imported = await local.call("/api/outfitter/data/import", owner, { method: "POST", body: { archive, map, previewToken } });
    assert.equal(imported.status, 200, await imported.clone().text());
  }
}

test("a Wiki archive pulls into another installation and later pulls carry prod edits", async () => {
  const prod = await appWorker("onto", pack, prodId);
  const local = await appWorker("onto", pack, localId);
  try {
    for (const app of [prod, local])
      assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
    // Seed one prod record through the existing Wiki import.
    const transfer = { format: "outfitter-wiki-transfer-v1", types: [], nodes: [node], edges: [] };
    const preview = await prod.call("/api/apps/wiki-map/graph/preview", owner, { method: "POST", body: transfer });
    const { previewToken } = await preview.json() as { previewToken: string };
    assert.equal((await prod.call("/api/apps/wiki-map/graph/restore", owner, { method: "POST", body: { transfer, previewToken } })).status, 200);

    assert.equal((await local.call("/api/outfitter/data/export", { ...owner, role: "member" })).status, 403);
    await pull(local, await exportAll(prod));
    const snapshot = async () => (await (await local.call("/api/apps/wiki-map/graph/snapshot", owner)).json()) as { nodes: { id: string; title: string }[] };
    assert.equal((await snapshot()).nodes.find((n) => n.id === node.id)?.title, "Archive Org");

    // Edit in prod through the ordinary entity API, then pull again.
    const updated = await prod.call("/api/apps/wiki-map/graph/update", owner, { method: "POST", body: { type: "graph-node", id: node.id, revision: 1, attributes: { title: "Renamed in prod" } } });
    assert.equal(updated.status, 200, await updated.clone().text());
    await pull(local, await exportAll(prod));
    assert.equal((await snapshot()).nodes.find((n) => n.id === node.id)?.title, "Renamed in prod");
  } finally {
    await prod.dispose();
    await local.dispose();
  }
});

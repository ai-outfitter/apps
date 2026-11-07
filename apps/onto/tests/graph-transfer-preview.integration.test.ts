import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { core } from "../src/lib/graph";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const root = "/api/apps/wiki-map/graph";
test("graph import previews do not write and bind receipts to the destination and unchanged file", async () => {
  const app = await appWorker(
    "wiki-map",
    new URL(
      "../.outfitter/packages/operational.json",
      import.meta.url,
    ),
  );
  const document = {
    format: "outfitter-wiki-transfer-v1",
    types: [],
    nodes: [
      {
        id: "81000000-0000-4000-8000-000000000003",
        typeId: core.organization,
        slug: "preview-test",
        title: "Preview test",
      },
    ],
    edges: [],
  };
  try {
    const preview = await app.call(`${root}/preview`, owner, {
      method: "POST",
      body: document,
    });
    assert.equal(preview.status, 200, await preview.clone().text());
    const plan = (await preview.json()) as {
      previewToken: string;
      added: unknown;
      destination: { installationId: string };
    };
    assert.deepEqual(plan.added, { types: 0, nodes: 1, edges: 0 });
    let snapshot = (await (
      await app.call(`${root}/snapshot`, owner)
    ).json()) as { nodes: { id: string }[] };
    assert.ok(!snapshot.nodes.some((node) => node.id === document.nodes[0].id));
    const changed = await app.call(`${root}/restore`, owner, {
      method: "POST",
      body: {
        transfer: {
          ...document,
          nodes: [{ ...document.nodes[0], title: "Different" }],
        },
        previewToken: plan.previewToken,
      },
    });
    assert.equal(changed.status, 409);
    const applied = await app.call(`${root}/restore`, owner, {
      method: "POST",
      body: { transfer: document, previewToken: plan.previewToken },
    });
    assert.equal(applied.status, 200, await applied.clone().text());
    const result = (await applied.json()) as {
      added: unknown;
      receipt: { owner: unknown; installationId: string; previewToken: string };
    };
    assert.deepEqual(result.added, plan.added);
    assert.equal(
      result.receipt.installationId,
      plan.destination.installationId,
    );
    assert.equal(result.receipt.previewToken, plan.previewToken);
    assert.deepEqual(result.receipt.owner, { kind: "organization", id: "org" });
    const stale = await app.call(`${root}/restore`, owner, {
      method: "POST",
      body: { transfer: document, previewToken: plan.previewToken },
    });
    assert.equal(stale.status, 409);
    const conflict = await app.call(`${root}/preview`, owner, {
      method: "POST",
      body: {
        ...document,
        nodes: [{ ...document.nodes[0], title: "Different" }],
      },
    });
    assert.equal(conflict.status, 409);
    const duplicate = await app.call(`${root}/preview`, owner, {
      method: "POST",
      body: {
        ...document,
        nodes: [
          { ...document.nodes[0], id: "81000000-0000-4000-8000-000000000004" },
        ],
      },
    });
    assert.equal(duplicate.status, 409);
    const backup = (await (await app.call(`${root}/export`, owner)).json()) as {
      transfer: { nodes: { id: string }[] };
      graph: unknown;
      notes: unknown[];
    };
    assert.ok(backup.graph);
    assert.ok(backup.notes.length);
    assert.ok(
      backup.transfer.nodes.some((node) => node.id === document.nodes[0].id),
    );
    const forbidden = await app.call(
      `${root}/preview`,
      { ...owner, role: "member" },
      { method: "POST", body: document },
    );
    assert.equal(forbidden.status, 403);
  } finally {
    await app.dispose();
  }
});

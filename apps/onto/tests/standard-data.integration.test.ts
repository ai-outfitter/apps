import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { standardData } from "../src/lib/standard-data";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const reader = { ...owner, userId: "reader", role: "member" };
const init = "/api/internal/app-initialize";
const snapshot = "/api/apps/wiki-map/graph/snapshot";

test("JSON initialization is editor-only and repeated uploads leave the graph unchanged", async () => {
  const app = await appWorker(
    "wiki-map",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
  try {
    // Fresh migrations contain no standard data; only initialization adds it.
    assert.equal((await app.database.prepare("SELECT count(*) AS n FROM graph_types").first())?.n, 0);
    assert.equal((await app.database.prepare("SELECT count(*) AS n FROM graph_nodes").first())?.n, 0);
    assert.equal(
      (await app.call(init, undefined, { method: "POST", body: {} })).status,
      401,
    );
    assert.equal(
      (await app.call(init, reader, { method: "POST", body: {} })).status,
      403,
    );
    const upload = () => app.call(init, owner, { method: "POST", body: {} });
    const response = await upload();
    assert.equal(response.status, 200, await response.clone().text());
    const before = (await (await app.call(snapshot, reader)).json()) as {
      types: { id: string; archived: boolean }[];
      nodes: unknown[];
    };
    assert.equal(before.types.filter(type => !type.archived).length, standardData.types.length);
    // Retired SoftwareProduct definitions belong to existing legacy history.
    assert.ok(!before.types.some(type => type.id === "71000000-0000-4000-8000-000000000008"));
    assert.equal(before.nodes.length, standardData.nodes.length);
    assert.equal((await upload()).status, 200);
    assert.deepEqual(await (await app.call(snapshot, reader)).json(), before);
  } finally {
    await app.dispose();
  }
});

test("setup preserves edited and archived records and adds physically missing records again", async () => {
  const app = await appWorker(
    "wiki-map",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
  try {
    const upload = () => app.call(init, owner, { method: "POST", body: {} });
    assert.equal((await upload()).status, 200);
    const type =
      standardData.types.find((t) => t.name === "ProductRevision") ??
      assert.fail("missing type");
    await app.database
      .prepare(
        "UPDATE graph_types SET body='Owner revision notes', archived=1, revision=2 WHERE id=?",
      )
      .bind(type.id)
      .run();
    const lens =
      standardData.nodes.find(
        (n) => n.title === "Release candidate evidence",
      ) ?? assert.fail("missing lens");
    await app.database
      .prepare("DELETE FROM graph_nodes WHERE id=?")
      .bind(lens.id)
      .run();
    // Reading does not upload data or restore a snapshot's missing records.
    assert.equal((await app.call(snapshot, owner)).status, 200);
    assert.equal(
      await app.database
        .prepare("SELECT id FROM graph_nodes WHERE id=?")
        .bind(lens.id)
        .first(),
      null,
    );
    assert.equal((await upload()).status, 200);
    assert.deepEqual(
      await app.database
        .prepare("SELECT body,archived,revision FROM graph_types WHERE id=?")
        .bind(type.id)
        .first(),
      { body: "Owner revision notes", archived: 1, revision: 2 },
    );
    assert.equal(
      (
        await app.database
          .prepare("SELECT id FROM graph_nodes WHERE id=?")
          .bind(lens.id)
          .first()
      )?.id,
      lens.id,
    );
  } finally {
    await app.dispose();
  }
});

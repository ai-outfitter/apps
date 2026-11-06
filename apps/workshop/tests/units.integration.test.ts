import assert from "node:assert/strict";
import test from "node:test";
import { actionPath } from "@ai-outfitter/app-sdk/actions";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import type { Unit } from "../src/server/units";

// The built operational worker keeps one inventory row per physical unit,
// told apart by MAC address, and serves the inventory over graph.graphql.
const member = { userId: "member", organizationId: "org", role: "member" };
const artifact = () => appArtifact(new URL("..", import.meta.url), "operational");
const units = "/api/apps/workshop/units";

test("inventory: ESP32-S3 units by MAC address, with firmware, over the API and graph.graphql", async () => {
  const app = await appWorker("workshop", artifact(), "units");
  try {
    const post = (body: unknown) => app.call(units, member, { method: "POST", body });
    const created = await post({ partNumber: "SNY-C001", mpn: "ESP32-S3-DevKitC-1-N8R8", mac: "34-85-18-7a-10-01", location: "Bin A3" });
    assert.equal(created.status, 201, await created.clone().text());
    const unit = (await created.json()) as Unit;
    // Any common spelling is stored one way, so a second entry of the same board is caught.
    assert.deepEqual([unit.mac, unit.status, unit.revision], ["34:85:18:7A:10:01", "in-stock", 1]);
    assert.equal((await post({ partNumber: "SNY-C001", mac: "348518 7A1001".replace(" ", "") })).status, 409);
    assert.equal((await post({ partNumber: "SNY-C001", mac: "not-a-mac" })).status, 400);
    assert.equal((await post({ partNumber: "SNY-C001" })).status, 400);
    assert.equal((await post({ partNumber: "SNY-C002", serial: "SCD41-0007" })).status, 201);

    // Flashing and installing is an update against the revision read.
    const flashed = await app.call(`${units}/${unit.id}`, member, {
      method: "PUT",
      body: { revision: 1, unit: { partNumber: "SNY-C001", mpn: unit.mpn, mac: unit.mac, status: "installed", location: "Bench prototype 1", projectId: "00000000-0000-4000-8000-000000000106", firmware: "v0.1.0" } },
    });
    assert.equal(flashed.status, 200, await flashed.clone().text());
    assert.deepEqual(((await flashed.json()) as Unit).firmware, "v0.1.0");
    assert.equal((await app.call(`${units}/${unit.id}`, member, { method: "PUT", body: { revision: 1, unit: { partNumber: "SNY-C001", mac: unit.mac } } })).status, 409);

    const listed = (await (await app.call(units, member)).json()) as Unit[];
    assert.deepEqual(listed.map((u) => u.mac ?? u.serial), ["34:85:18:7A:10:01", "SCD41-0007"]);

    const graph = await app.call(`${actionPath}/call`, member, {
      method: "POST",
      body: { action: "graph.graphql", input: { query: `{ workshopUnits(mac: ["34:85:18:7A:10:01"]) { nodes { partNumber mac status firmware projectId } } }` }, access: "read" },
    });
    assert.equal(graph.status, 200, await graph.clone().text());
    assert.deepEqual(((await graph.json()) as { data: unknown }).data, {
      workshopUnits: { nodes: [{ partNumber: "SNY-C001", mac: "34:85:18:7A:10:01", status: "installed", firmware: "v0.1.0", projectId: "00000000-0000-4000-8000-000000000106" }] },
    });

    assert.equal((await app.call(`${units}/${unit.id}`, member, { method: "DELETE", body: { revision: 1 } })).status, 409);
    assert.equal((await app.call(`${units}/${unit.id}`, member, { method: "DELETE", body: { revision: 2 } })).status, 200);
  } finally {
    await app.dispose();
  }
});

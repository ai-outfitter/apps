import assert from "node:assert/strict";
import test from "node:test";
import manifest from "../app.json" with { type: "json" };

test("manual Forerunner declares private operation and a read-only demo", () => {
  assert.deepEqual(manifest.modes.demo.capabilities, []);
  assert.ok(manifest.modes.operational.capabilities.includes("actions.invoke"));
  assert.deepEqual(manifest.dependencies, ["wiki-map"]);
  assert.equal(manifest.dataLocation, "installation-database");
  assert.match(manifest.catalog.presentation.access, /Private manual board/);
  assert.match(
    manifest.catalog.presentation.access,
    /no mail or calendar is read and no model runs/,
  );
});

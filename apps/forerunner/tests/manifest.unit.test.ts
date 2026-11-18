import assert from "node:assert/strict";
import test from "node:test";
import manifest from "../app.json" with { type: "json" };

test("manual Forerunner declares private operation and a read-only demo", () => {
  assert.deepEqual(manifest.modes.demo.capabilities, []);
  assert.ok(manifest.modes.operational.capabilities.includes("actions.invoke"));
  // The brief is saved in the Wiki, read through `page.document` (Wiki 0.1.5).
  assert.deepEqual(manifest.dependencies, { onto: "*", "wiki-map": ">=0.1.5" });
  assert.equal(manifest.dataLocation, "installation-database");
  assert.match(manifest.catalog.presentation.access, /Private manual board/);
  assert.match(
    manifest.catalog.presentation.access,
    /no mail or calendar is read and no model runs/,
  );
});

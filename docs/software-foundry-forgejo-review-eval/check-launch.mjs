import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [stage, output, caseName] = process.argv.slice(2);
const pins = JSON.parse(readFileSync(join(stage, "pins.json"), "utf8"));
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
assert.ok(pins.cases.includes(caseName), "Case is present in exact launch pins");
const [imageId, webappTree, boxAppsTree] = readFileSync(join(output, "image.txt"), "utf8").trim().split(" ");
const webappCommit = readFileSync(join(output, "webapp-commit.txt"), "utf8").trim();
assert.deepEqual({ imageId, webappTree, boxAppsTree, webappCommit }, pins.image, "Exact box image and source labels");
const names = ["apps-tree.txt", "documents.json", "schema.graphql", "software-foundry.operational.json"];
const packageSha256 = Object.fromEntries(names.map(name => [name, digest(join(stage, "package", name))]));
assert.deepEqual(packageSha256, pins.packageSha256, "Exact installed package files");
assert.equal(readFileSync(join(stage, "package", "apps-tree.txt"), "utf8").trim(), pins.appsTree);
assert.equal(readFileSync(join(output, "base.sha"), "utf8").trim(), pins.fixtureBase);
for (const [name, expected] of Object.entries(pins.sourceSha256)) {
  assert.match(name, /^(?:eval|planwork)\/[A-Za-z0-9._/-]+$/);
  assert.ok(!name.split("/").includes(".."));
  assert.equal(digest(join(stage, name)), expected, `Exact eval source ${name}`);
}
if (caseName === "mixed-gateway")
  assert.equal(digest(join(stage, "legacy-gateway.mjs")), pins.legacyGatewaySha256);
writeFileSync(join(output, "launch.json"), JSON.stringify({
  ...pins, case: caseName, pinsSha256: digest(join(stage, "pins.json")),
}, null, 2) + "\n");

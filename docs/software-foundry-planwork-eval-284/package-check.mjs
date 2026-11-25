import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [directory, imageId, platformTree, boxAppsTree] = process.argv.slice(2);
const pins = JSON.parse(readFileSync(new URL("./pins.json", import.meta.url)));
assert.equal(process.versions.node.split(".")[0], "24", "Use Node 24");
assert.equal(imageId?.replace(/^sha256:/, ""), pins.imageId, "Replay requires the immutable verified image");
assert.equal(platformTree, pins.platformTree);
assert.equal(boxAppsTree, pins.boxAppsTree);
const read = file => readFileSync(join(directory, file));
assert.equal(read("apps-tree.txt").toString().trim(), pins.appsTree);
for (const [file, expected] of Object.entries(pins.packageSha256)) {
  assert.equal(createHash("sha256").update(read(file)).digest("hex"), expected, file);
}
const documents = JSON.parse(read("documents.json"));
const plan = documents.find(document => document.name === "PlanWork");
assert.equal(plan?.executionTimeoutMs, 840_000);
assert.ok(plan.mcp && documents.some(document => document.name === "FoundryPlan" && document.mcp));
const pack = JSON.parse(read("software-foundry.operational.json"));
const workflow = pack.manifest.workflows.find(item => item.definition.id === "foundry-plan-work");
const step = workflow.definition.steps.find(item => item.id === "plan");
assert.deepEqual(step.inference, { maxOutputTokens: pins.maxOutputTokens, reasoningEffort: "low" });

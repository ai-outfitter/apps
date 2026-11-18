import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nextVersion } from "../../../box/lib.mjs";
import { parseRequest, readRequests } from "../box/intake.mjs";
import { evidenceBundle } from "../box/release.mjs";
import { billOfMaterials, designResult, exportSummary } from "../box/results.mjs";
import { screenshotName, workbenchPath } from "../box/screenshots.mjs";
import { makeProject } from "../src/lib/project";
import { CadPlanSchema } from "../src/model/cad-plan";
import { DesignRequest, DesignResult, EvidenceBundle, boxJsonSchema, boxSchemas } from "../src/box/contract";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../box/fixtures/${name}`, import.meta.url), "utf8"));
const model = { provider: "spark", id: "GLM-5.3-Flash-EXL3" };

test("the fixtures are valid box documents", () => {
  assert.deepEqual(DesignRequest.parse(fixture("design-request.json")).followUps, ["Make the hole 12 mm in diameter."]);
  DesignResult.parse(fixture("design-result.json"));
  EvidenceBundle.parse(fixture("evidence-bundle.json"));
});

test("a designed result names its commit, and a failed one says why", () => {
  const { commitSha: _sha, ...noCommit } = fixture("design-result.json");
  assert.equal(DesignResult.safeParse(noCommit).success, false);
  assert.equal(DesignResult.safeParse({ ...noCommit, status: "failed" }).success, false);
  assert.equal(DesignResult.safeParse({ ...noCommit, status: "failed", reason: "The design agent answered 502" }).success, true);
});

test("requests get a folder from their title, and two may not share one", () => {
  const request = parseRequest(fixture("design-request.json"));
  assert.equal(request.slug, "cable-clip");
  assert.throws(() => parseRequest({ ...request, message: "x".repeat(501) }), /message/);
  const folder = mkdtempSync(join(tmpdir(), "workshop-requests-"));
  writeFileSync(join(folder, "a.json"), JSON.stringify(fixture("design-request.json")));
  writeFileSync(join(folder, "b.json"), JSON.stringify({ ...fixture("design-request.json"), requestId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f" }));
  assert.throws(() => readRequests(folder), /designs\/cable-clip/);
});

test("export.ts builds the model with Workshop's geometry, and the driver's documents match the contract", () => {
  const work = mkdtempSync(join(tmpdir(), "workshop-export-"));
  const base = makeProject("cube");
  const plan = CadPlanSchema.parse({ version: 1, units: "mm", features: [
    { kind: "box", mode: "add", origin: [-30, -20, 0], size: [60, 40, 20] },
    { kind: "cylinder", mode: "cut", base: [0, 0, 0], radius: 5, height: 20, axis: "z" },
  ] });
  const project = { ...base, name: "Cable clip", revision: 1, params: { ...base.params, design: "custom", width: 60, depth: 40, height: 20 }, cadPlan: plan,
    iterations: [{ id: crypto.randomUUID(), prompt: "A block with a hole.", rationale: "A block.", dimensions: { width: 60, depth: 40, height: 20 }, at: new Date().toISOString(), revision: 1 }] };
  writeFileSync(join(work, "project.json"), JSON.stringify(project));
  const stdout = execFileSync(process.execPath, ["--import", "tsx", new URL("../box/export.ts", import.meta.url).pathname, join(work, "project.json"), work], { encoding: "utf8" });
  const exported = exportSummary(stdout);
  assert.deepEqual(exported.bounds, { width: 60, depth: 40, height: 20 });
  assert.ok(Math.abs(exported.volumeMm3 - (48000 - Math.PI * 25 * 20)) < 1);
  assert.match(readFileSync(join(work, "model.step"), "utf8").slice(0, 20), /ISO-10303-21/);
  const request = parseRequest(fixture("design-request.json"));
  const bom = billOfMaterials(project, exported);
  const files = [{ path: "designs/cable-clip/model.step", sha256: "d".repeat(64), bytes: 1, uri: "s3://workshop/designs/x/model.step" }];
  const geometry = { bounds: exported.bounds, volumeMm3: exported.volumeMm3, features: exported.features };
  const screenshots = [{ step: "design", revision: 1, path: `screenshots/${request.requestId}/${screenshotName(1, "design")}`, sha256: "e".repeat(64), bytes: 1,
    uri: "s3://workshop/designs/x/screenshots/1-design.png", ready: true }];
  const result = designResult({ request, project, geometry, bom, files, screenshots, commitSha: "a".repeat(40), model,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  assert.equal(DesignResult.parse(result).status, "designed");
  assert.equal(result.screenshots?.[0]?.path, `screenshots/${request.requestId}/1-design.png`);
  assert.equal(screenshotName(2, "follow-up 1"), "2-follow-up-1.png");
  assert.equal(workbenchPath(project), `/projects/${project.id.slice(-12)}/assembly`);
  const failed = designResult({ request, model, error: new Error("The design agent answered 502"), startedAt: result.startedAt, finishedAt: result.finishedAt });
  assert.equal(DesignResult.parse(failed).reason, "The design agent answered 502");
  const bundle = evidenceBundle({ tag: "v0.1.0", version: "0.1.0", commitSha: "a".repeat(40), model, designed: [{ request, result }], artifacts: [],
    build: { command: "c", image: "i", startedAt: result.startedAt, finishedAt: result.finishedAt } });
  EvidenceBundle.parse(bundle);
});

test("releases bump from the highest tag", () => {
  assert.equal(nextVersion([], ["patch"]), "0.0.1");
  assert.equal(nextVersion(["v0.1.0", "v0.2.3", "notes"], ["patch", "minor"]), "0.3.0");
});

test("committed JSON Schemas match the contract", () => {
  for (const name of Object.keys(boxSchemas) as (keyof typeof boxSchemas)[]) {
    const committed = JSON.parse(readFileSync(new URL(`../box/schemas/${name}.schema.json`, import.meta.url), "utf8"));
    assert.deepEqual(committed, JSON.parse(JSON.stringify(boxJsonSchema(name))), `${name}: run scripts/box-schemas.ts`);
  }
});

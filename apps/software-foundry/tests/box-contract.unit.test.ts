import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EvidenceBundle, RunResult, WorkRequest, boxJsonSchema, boxSchemas } from "../src/box/contract";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../box/fixtures/${name}`, import.meta.url), "utf8"));

test("feature and bug request fixtures are valid work requests", () => {
  assert.equal(WorkRequest.parse(fixture("feature-request.json")).delivery, "pull_request");
  const bug = WorkRequest.parse(fixture("bug-request.json"));
  assert.equal(bug.delivery, "direct_commit");
  assert.equal(bug.constraints, undefined);
});

test("a bug request needs bug details and a feature request carries none", () => {
  const { bug: _bug, ...noDetails } = fixture("bug-request.json");
  assert.match(WorkRequest.safeParse(noDetails).error?.message ?? "", /bug requests need bug details/);
  const feature = { ...fixture("feature-request.json"), bug: fixture("bug-request.json").bug };
  assert.equal(WorkRequest.safeParse(feature).success, false);
});

test("acceptance criterion ids are unique", () => {
  const request = fixture("feature-request.json");
  request.acceptanceCriteria[1].id = request.acceptanceCriteria[0].id;
  assert.equal(WorkRequest.safeParse(request).success, false);
});

test("a landed pull request result names its merge commit", () => {
  const result = fixture("run-result.landed.json");
  assert.equal(RunResult.parse(result).status, "landed");
  delete result.change.mergeSha;
  assert.equal(RunResult.safeParse(result).success, false);
});

test("needs_details carries its questions", () => {
  const { change: _change, release: _release, ...rest } = fixture("run-result.landed.json");
  const result = { ...rest, status: "needs_details", triage: { plan: "", questions: [] } };
  assert.equal(RunResult.safeParse(result).success, false);
  result.triage.questions.push("Which report?");
  assert.equal(RunResult.safeParse(result).success, true);
});

test("evidence must be stored, hashed and pinned to a commit", () => {
  const bundle = fixture("evidence-bundle.json");
  EvidenceBundle.parse(bundle);
  bundle.criteria[0].evidence[0].uri = "https://example.com/desktop.png";
  assert.equal(EvidenceBundle.safeParse(bundle).success, false);
});

test("committed JSON Schemas match the contract", () => {
  for (const name of Object.keys(boxSchemas) as (keyof typeof boxSchemas)[]) {
    const committed = JSON.parse(readFileSync(new URL(`../box/schemas/${name}.schema.json`, import.meta.url), "utf8"));
    assert.deepEqual(committed, JSON.parse(JSON.stringify(boxJsonSchema(name))), `${name}: run scripts/box-schemas.ts`);
  }
});

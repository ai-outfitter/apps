import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactRef,
  changedSinceCited,
  evidenceItem,
  evidenceKey,
  evidenceList,
} from "../src/evidence";
import { assertionBody } from "../src/graph-contracts/index";

const hash = "a".repeat(64);

test("an artifact reference needs a provider and record ID", () => {
  assert.ok(artifactRef.safeParse({ provider: "github", recordId: "acme/web/check-runs/1", version: "abc123" }).success);
  assert.equal(artifactRef.safeParse({ provider: "github" }).success, false);
  assert.equal(artifactRef.safeParse({ provider: "", recordId: "x" }).success, false);
  assert.equal(artifactRef.safeParse({ provider: "x", recordId: "y", version: "" }).success, false);
  assert.equal(artifactRef.safeParse({ provider: "x", recordId: "y", version: "v".repeat(201) }).success, false);
});

test("an artifact reference refuses quotes, unknown fields, bad hashes and non-HTTP links", () => {
  assert.equal(artifactRef.safeParse({ provider: "x", recordId: "y", quote: "hi" }).success, false);
  assert.equal(artifactRef.safeParse({ provider: "x", recordId: "y", contentHash: "ABC" }).success, false);
  assert.equal(artifactRef.safeParse({ provider: "x", recordId: "y", uri: "file:///etc/passwd" }).success, false);
});

test("an evidence item adds the quote and observation time", () => {
  const item = {
    provider: "gmail",
    recordId: "synthetic-message-42",
    quote: "Let's go climbing on Thursday.",
    observedAt: "2026-11-02T18:00:00Z",
    contentHash: hash,
  };
  assert.deepEqual(evidenceItem.parse(item), item);
  assert.equal(evidenceItem.safeParse({ ...item, observedAt: "yesterday" }).success, false);
  assert.equal(evidenceItem.safeParse({ ...item, quote: "q".repeat(2001) }).success, false);
});

test("an evidence list holds at most 32 citations", () => {
  const item = { provider: "x", recordId: "y" };
  assert.ok(evidenceList.safeParse(Array(32).fill(item)).success);
  assert.equal(evidenceList.safeParse(Array(33).fill(item)).success, false);
});

test("citations of one artifact version share a key; other versions or hashes do not", () => {
  const a = { provider: "wiki", recordId: "w1/n1", version: "3" };
  assert.equal(evidenceKey(a), evidenceKey({ ...a, quote: "different excerpt" } as never));
  assert.notEqual(evidenceKey(a), evidenceKey({ ...a, version: "4" }));
  assert.notEqual(evidenceKey(a), evidenceKey({ ...a, contentHash: hash }));
});

test("a citation is changed only when both sides carry a different version", () => {
  assert.equal(changedSinceCited({ version: "3" }, { version: "4" }), true);
  assert.equal(changedSinceCited({ version: "3" }, { version: "3" }), false);
  assert.equal(changedSinceCited({}, { version: "4" }), false);
});

test("existing assertion payloads still parse unchanged", () => {
  const assertion = {
    schemaVersion: 1,
    subject: { type: "graph-node", id: "00000000-0000-4000-8000-000000000001", revision: 2 },
    stance: "supports",
    status: "proposed",
    uncertainty: { reason: "Mentioned in one email.", confidence: 0.7 },
    evidence: [{ provider: "gmail", recordId: "m1", uri: "https://mail.example/m1", quote: "Hi", observedAt: "2026-11-02T18:00:00+01:00", contentHash: hash }],
    provenance: { method: "inference", generatedAt: "2026-11-02T18:00:00Z", agentId: "forerunner", runId: "run-1" },
  };
  assert.deepEqual(assertionBody.parse(assertion), assertion);
  assert.equal(assertionBody.safeParse({ ...assertion, evidence: [{ provider: "gmail" }] }).success, false);
});

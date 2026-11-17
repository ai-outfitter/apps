import { resolvePcbSnapshot } from "../src/lib/pcb-snapshot-review";
import test from "node:test";
import assert from "node:assert/strict";
import {
  hasPcbReview, missingFileMessage, parsePcbReview, PcbReviewSchema, pcbReviewArtifact, powerRows,
  quotesHeading, resolveWorkspacePcbBuild,
} from "../src/lib/pcb-review";
import { makeProject } from "../src/lib/project";

const hash = "a".repeat(64), path = `${hash}/board.glb`;
const artifacts = [{ path, sha256: hash, bytes: 100, contentType: "model/gltf-binary" }];
const fixture = () => ({ title: "Board", revision: "A", boardSha256: hash, dimensions: "100 x 80", components: 1, model: path, modelNote: "", status: "Prototype", parts: [{ Reference: "U1", Quantity: "1", MPN: "ABC", Value: "MCU", Footprint: "QFN", Description: "Controller" }], checks: [], power: { modes: { idle: { input_w: .01, input_w_plus_20pct: .012 } } }, powerNotes: "", manufacturingNote: "", downloads: [], quotes: [{ quantity: 5, status: "Pending", total: null, currency: "USD", detail: "Not quoted" }] });
const quote = { quantity: 5, status: "Quoted", total: 12, currency: "USD", supplier: "Supplier", quoteId: "vendor-123", quotedAt: "2026-11-17T18:00:00Z", scope: "PCB and standard assembly", evidence: `${hash}/quote.pdf`, detail: "" };

test("pending quotes preserve unknown total and accept registered GLB", () => assert.equal(parsePcbReview(fixture(), artifacts).quotes[0].total, null));
test("reject price without supplier evidence", () => { const r = fixture(); assert.throws(() => PcbReviewSchema.parse({ ...r, quotes: [{ ...r.quotes[0], total: 12 }] })); });
test("reject unregistered models and traversal", () => { assert.throws(() => parsePcbReview(fixture(), [])); assert.throws(() => parsePcbReview({ ...fixture(), model: `${hash}/../board.glb` }, artifacts)); });
test("reject duplicate references, count mismatch and invalid power", () => { const r = fixture(); assert.throws(() => PcbReviewSchema.parse({ ...r, parts: [...r.parts, ...r.parts], components: 2 })); assert.throws(() => PcbReviewSchema.parse({ ...r, components: 4 })); assert.throws(() => PcbReviewSchema.parse({ ...r, power: { modes: { idle: { input_w: -1, input_w_plus_20pct: 0 } } } })); });
test("quoted evidence must also be registered", () => { const quoted = { ...fixture(), quotes: [quote] }; assert.throws(() => parsePcbReview(quoted, artifacts)); assert.equal(parsePcbReview(quoted, [...artifacts, { path: `${hash}/quote.pdf`, sha256: hash, bytes: 50, contentType: "application/pdf" }]).quotes[0].total, 12); });

test("a quoted price needs supplier, scope, reference, date and a positive total", () => {
  const r = fixture();
  for (const key of ["supplier", "scope", "quoteId", "quotedAt", "evidence", "currency"] as const) {
    const { [key]: _, ...missing } = quote;
    assert.throws(() => PcbReviewSchema.parse({ ...r, quotes: [missing] }), key);
  }
  assert.throws(() => PcbReviewSchema.parse({ ...r, quotes: [{ ...quote, total: 0 }] }));
  assert.throws(() => PcbReviewSchema.parse({ ...r, quotes: [{ ...r.quotes[0], total: 0 }] }));
  assert.equal(PcbReviewSchema.parse({ ...r, quotes: [{ quantity: 10, status: "Blocked: sign-in needed", total: null, supplier: "Supplier", detail: "" }] }).quotes[0].total, null);
});

test("quote heading and power labels come from the data", () => {
  assert.equal(quotesHeading([quote]), "Supplier assembly quotes");
  assert.equal(quotesHeading([{ ...quote, supplier: "Acme" }]), "Acme assembly quotes");
  assert.equal(quotesHeading(fixture().quotes as never), "Supplier assembly quotes");
  const legacy = PcbReviewSchema.parse(fixture());
  assert.equal(powerRows(legacy)[0].withMargin?.label, "with 20% margin");
  const stated = PcbReviewSchema.parse({ ...fixture(), power: { inputVoltageV: 24, marginPercent: 30, modes: { idle: { input_w: 1, input_w_with_margin: 1.3 } } } });
  assert.deepEqual(powerRows(stated)[0].withMargin, { watts: 1.3, label: "with 30% margin" });
  assert.throws(() => PcbReviewSchema.parse({ ...fixture(), power: { modes: { idle: { input_w: 1, input_w_with_margin: 1.3 } } } }));
});

const review = { path: `${"b".repeat(64)}/pcb-review.json`, sha256: "b".repeat(64), bytes: 10, contentType: "application/json" };
const source = { path: `${"c".repeat(64)}/source.tar`, sha256: "c".repeat(64), bytes: 10, contentType: "application/x-tar" };
const manifest = { version: 1 as const, units: "mm" as const, sourceCommit: "d".repeat(40), sourceHash: "c".repeat(64), compiler: "kicad", runner: "local", parameters: {}, assembly: makeProject("cube").assembly, artifacts: [source, review, ...artifacts], tests: [], notes: "", startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-01T00:01:00Z" };
const build = (id: string, status: "succeeded" | "failed", withManifest = true) => ({ id, repository: "https://example.com/repo", sourceDir: ".", baseRevision: 3, sourceCommit: "d".repeat(40), instructions: "Import", parameters: {}, runner: "local", createdAt: "2026-11-01T00:00:00Z", status, result: { ...(withManifest ? { manifest } : {}), ...(status === "failed" ? { error: "checks failed" } : {}), artifactBase: `/files/main/builds/p/${id}/`, stale: false } });
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";

test("the review artifact must be content-addressed and unique", () => {
  assert.equal(pcbReviewArtifact(manifest.artifacts), review);
  assert.equal(pcbReviewArtifact([{ ...review, path: `${"e".repeat(64)}/pcb-review.json` }]), undefined);
  assert.equal(pcbReviewArtifact([review, { ...review, path: "x/pcb-review.json" }]), review);
  assert.equal(pcbReviewArtifact([review, { ...review, sha256: "f".repeat(64), path: `${"f".repeat(64)}/pcb-review.json` }]), undefined);
});

test("resolve the exact requested build, never a fallback", () => {
  const workspace = { repository: "r", sourceDir: ".", requests: [build(A, "succeeded"), build(B, "succeeded"), build(C, "failed", false)], currentBuildId: B };
  const current = resolveWorkspacePcbBuild(workspace, null);
  assert.ok(current.ok && current.build.id === B && current.provenance.current);
  assert.ok(current.ok && current.notes.some(n => n.includes("failed")));
  assert.equal(current.ok && current.artifactBase, `/files/main/builds/p/${B}/`);
  const historical = resolveWorkspacePcbBuild(workspace, A);
  assert.ok(historical.ok && historical.build.id === A && !historical.provenance.current);
  const missing = resolveWorkspacePcbBuild(workspace, "44444444-4444-4444-8444-444444444444");
  assert.ok(!missing.ok && missing.reason.includes("not found"));
  const failed = resolveWorkspacePcbBuild(workspace, C);
  assert.ok(!failed.ok && failed.reason.includes("checks failed"));
  assert.ok(hasPcbReview(workspace));
  const none = resolveWorkspacePcbBuild({ ...workspace, currentBuildId: undefined, requests: [build(C, "failed", false)] }, null);
  assert.ok(!none.ok && none.reason.includes("latest build") && none.reason.includes("failed"));
  assert.equal(hasPcbReview(undefined), false);
  assert.ok(!resolveWorkspacePcbBuild(undefined, null).ok);
});

test("missing files are only called expired after the retention period", () => {
  const finished = "2026-01-01T00:00:00Z", day = 86_400_000;
  assert.match(missingFileMessage("model", 404, finished, Date.parse(finished) + 400 * day), /expired/);
  assert.doesNotMatch(missingFileMessage("model", 404, finished, Date.parse(finished) + 10 * day), /expired/);
  assert.match(missingFileMessage("model", 500, finished), /HTTP 500/);
});

test("imported snapshot selection never falls back from a missing historical id",()=>{
  const snapshot={id:A,origin:"imported" as const,importedAt:"2026-11-17T00:00:00Z",importedBy:"member",reviewPath:review.path,manifest,artifactBase:"/files/main/builds/p/pcb/"+A+"/"};
  assert.equal(resolvePcbSnapshot([snapshot]).snapshot.id,A);
  assert.throws(()=>resolvePcbSnapshot([snapshot],B),/not found/);
  assert.throws(()=>resolvePcbSnapshot([{...snapshot,reviewPath:"wrong"}]),/matching/);
});

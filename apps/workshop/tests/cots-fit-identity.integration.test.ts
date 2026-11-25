import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Assembly } from "../src/lib/assembly";
import { assemblyItem, fixtureMember, photoInputs, purchasedPart, sharedCotsWorker } from "./fixtures/shared-cots";

test("a historical fit cannot transfer to a changed manufacturer at the same part revision", { timeout: 30_000 }, async t => {
  const fixture = await sharedCotsWorker();
  t.after(() => fixture.app.dispose());
  const library = await fixture.createProject("Field connector library", "component");
  const previous = purchasedPart();
  const libraryRoot = assemblyItem("Reference fixture", "LIBRARY", [{ itemId: previous.id, refdes: "J1" }]);
  const original = await fixture.saveAssembly(library.id, library.revision, {
    rootId: libraryRoot.id, items: [libraryRoot, previous],
  });
  const product = await fixture.createProject("Pinned fit fixture");
  const alias = { ...purchasedPart(), cotsEvidenceRef: { projectId: library.id, itemId: previous.id, revision: original.revision } };
  const productRoot = assemblyItem("Printed fixture", "TEST-ENCLOSURE", [{ itemId: alias.id, refdes: "J1" }]);
  const tested = await fixture.saveAssembly(product.id, product.revision, {
    rootId: productRoot.id, items: [productRoot, alias],
  });
  const changed = await fixture.saveAssembly(library.id, original.revision, {
    rootId: libraryRoot.id, items: [libraryRoot, { ...previous, manufacturer: "Different Manufacturer" }],
  });
  const { file, revision } = await fixture.attachPhoto(library.id, previous.id, changed.revision, photoInputs[0]);
  const response = await fixture.callGraph("RecordWorkshopCotsEvidence", {
    input: {
      projectId: library.id, itemId: previous.id, expectedRevision: revision,
      evidence: {
        photos: [{ fileName: file.fileName, sha256: file.sha256, attachmentRevision: revision, observation: "Replacement part photo." }],
        interfaces: [{
          id: randomUUID(), feature: "Latch depth", datum: "Mating face", axis: "X", unit: "mm",
          tolerance: { kind: "unknown" }, photoSha256s: [file.sha256],
          verification: {
            status: "fits", trialId: randomUUID(), testedProjectId: product.id, testedRevision: tested.revision,
            observation: "Attempt to reuse a test of the previous purchased component.", photoSha256s: [file.sha256],
          },
        }],
      },
    },
  }, fixtureMember);
  assert.equal(response.result.errors?.[0]?.extensions?.status, 409, JSON.stringify(response.result));
  assert.match(response.result.errors?.[0]?.message ?? "", /tested revision does not contain this purchased-part revision/i);
});

test("an item without a manufacturer part number cannot carry evidence to a different part number", { timeout: 30_000 }, async t => {
  const fixture = await sharedCotsWorker();
  t.after(() => fixture.app.dispose());
  const library = await fixture.createProject("Purchased gland library", "component");
  const original = { ...purchasedPart(), mpn: "" };
  const root = assemblyItem("Reference fixture", "LIBRARY", [{ itemId: original.id, refdes: "J1" }]);
  const saved = await fixture.saveAssembly(library.id, library.revision, { rootId: root.id, items: [root, original] });
  const recorded = await fixture.graph<{ revision: number }>("RecordWorkshopCotsEvidence", {
    input: {
      projectId: library.id, itemId: original.id, expectedRevision: saved.revision,
      evidence: {
        photos: [],
        interfaces: [{
          id: randomUUID(), feature: "Latch depth", datum: "Mating face", axis: "X", unit: "mm",
          nominal: { value: 2, basis: "design", source: "Fixture drawing" },
          tolerance: { kind: "unknown" }, photoSha256s: [], verification: { status: "untested" },
        }],
      },
    },
  });
  const { assembly } = await fixture.graph<{ assembly: Assembly }>("WorkshopAssembly", { projectId: library.id });
  const response = await fixture.callGraph("UpdateWorkshopAssembly", {
    projectId: library.id, expectedRevision: recorded.revision,
    assembly: { ...assembly, items: assembly.items.map(item => item.id === original.id ? { ...item, number: "REPLACEMENT-CONNECTOR" } : item) },
  }, fixtureMember);
  assert.equal(response.result.errors?.[0]?.extensions?.status, 400, JSON.stringify(response.result));
  assert.match(response.result.errors?.[0]?.message ?? "", /purchased-part evidence/i);
});

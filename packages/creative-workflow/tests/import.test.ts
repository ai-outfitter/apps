import test from "node:test";
import assert from "node:assert/strict";
import { importArtera } from "../src/import.ts";
import { digest } from "../src/index.ts";
test("repeatable Artera import retains unknown provenance and only explicit picks, with no executor", async () => {
  const raw = {
    format: "artera-creative-import/1",
    source: { deck: "docs/deck" },
    files: {
      "prompts/IMG-01.md": "@shared/design.md\nHero",
      "prompts/shared/design.md": "Spacecraft description",
    },
    candidates: [
      {
        source: { image: "IMG-01-a.png" },
        snapshot: null,
        provenance: "unknown",
        artifact: { sha256: "a".repeat(64) },
      },
    ],
    feedback: [
      { image: "IMG-01-a.png", verdict: "pick", note: "Keep this one" },
    ],
    selections: [
      { slot: "hero", file: "IMG-01-a.png", explicit: true },
      { slot: "default", file: "IMG-01-a.png", explicit: false },
    ],
  };
  const manifest = { ...raw, hash: await digest(JSON.stringify(raw)) };
  const records = new Map(),
    staged = new Map();
  const options = {
    installationId: "onto",
    subject: { id: "00000000-0000-4000-8000-000000000001", revision: 1 },
    owner: {
      installationId: "presentations",
      type: "repository",
      id: "artera",
    },
    batchId: "batch",
    read: async (_id: string, address: string) => records.get(address) ?? null,
    stage: async (input: any) => {
      staged.set(input.address, input);
      return { address: input.address };
    },
    artifact: async (row: any) => ({
      provider: "repository",
      recordId: row.source.image,
      contentHash: row.artifact.sha256,
    }),
  };
  const first = await importArtera(manifest, options);
  assert.deepEqual(first.deferredSelections, ["hero"]);
  assert.equal(staged.size, 3);
  await importArtera(manifest, options);
  assert.equal(staged.size, 3);
  for (const [id, row] of staged)
    records.set(id, { revision: 1, body: row.body });
  staged.clear();
  await importArtera(manifest, options);
  assert.equal(staged.size, 1);
  assert.equal([...staged.values()][0].kind, "CreativeSelection");
  const candidate = [...records.values()].find((r) => r.body.artifact);
  assert.equal(candidate.body.snapshot, undefined);
  assert.equal(candidate.body.sourceRecord.image, "IMG-01-a.png");
  await assert.rejects(
    () => importArtera({ ...manifest, files: {} }, options),
    /manifest changed/,
  );
});

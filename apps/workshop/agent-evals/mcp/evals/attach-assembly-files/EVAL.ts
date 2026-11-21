import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "vitest";

const load = (name: string) => readFileSync(join(import.meta.dirname, name));
const { trace, baseline, final, spacerId, clampId, editedRevision } =
  JSON.parse(load("evidence.json").toString());
type Event = {
  tool: string;
  document?: string;
  discovered?: string[];
  revision?: number;
  expectedRevision?: number;
  fileName?: string;
  itemId?: string;
  status?: string;
  errors?: number[];
  verifiedFile?: { sha256: string; bytes: number };
  httpStatus?: number;
};
const events = trace as Event[];
test("discovers the read, upload and verification operations before using each", () => {
  for (const name of [
    "WorkshopAssembly",
    "UploadWorkshopAssemblyFile",
    "VerifyWorkshopAssemblyFile",
  ]) {
    const discovery = events.findIndex(
      (e) => e.tool === "graph_documents" && e.discovered?.includes(name),
    );
    expect(discovery, name).toBeGreaterThanOrEqual(0);
    expect(
      events.findIndex((e) => e.document === name),
      name,
    ).toBeGreaterThan(discovery);
  }
});
test("receives a stale-save refusal, rereads the new revision and preserves the teammate's edit", () => {
  expect(editedRevision).toBe(baseline.revision + 1);
  const stale = events.findIndex(
    (e) =>
      e.document === "UploadWorkshopAssemblyFile" &&
      e.expectedRevision === baseline.revision &&
      e.errors?.includes(409),
  );
  expect(stale).toBeGreaterThanOrEqual(0);
  const retry = events.findIndex(
    (e, i) =>
      i > stale &&
      e.document === "WorkshopAssembly" &&
      e.revision === editedRevision,
  );
  expect(retry).toBeGreaterThan(stale);
  expect(events.findIndex((e) => e.status === "attached")).toBeGreaterThan(
    retry,
  );
  expect(final.revision).toBe(editedRevision + 2);
  const cleaned = structuredClone(final.assembly);
  const part = cleaned.items.find((i: { id: string }) => i.id === spacerId);
  delete part.files;
  delete part.mesh;
  const expected = structuredClone(baseline.assembly);
  expected.items
    .find((i: { id: string }) => i.id === expected.rootId)
    .uses.find((u: { itemId: string }) => u.itemId === clampId).quantity = 3;
  expect(cleaned).toEqual(expected);
});
for (const name of ["spacer.stl", "spacer.step"])
  test("attaches and verifies the original " + name, () => {
    const original = load(name);
    const expected = {
      fileName: name,
      bytes: original.length,
      sha256: createHash("sha256").update(original).digest("hex"),
      projectId: final.projectId,
    };
    const part = final.assembly.items.find(
      (i: { id: string }) => i.id === spacerId,
    );
    expect(part.files).toHaveLength(2);
    expect(part.files).toContainEqual(expected);
    if (name.endsWith(".stl"))
      expect(part.mesh).toEqual({
        path: expected.sha256 + "/" + name,
        bounds: { min: [0, 0, 0], max: [10, 8, 4] },
      });
    const put = events.findIndex(
      (e) =>
        e.tool === "http_put" && e.fileName === name && e.httpStatus === 200,
    );
    const attach = events.findIndex(
      (e) =>
        e.document === "UploadWorkshopAssemblyFile" &&
        e.itemId === spacerId &&
        e.fileName === name &&
        e.status === "attached",
    );
    expect(put).toBeGreaterThanOrEqual(0);
    expect(attach).toBeGreaterThan(put);
    expect(
      events
        .slice(attach + 1)
        .find(
          (e) =>
            e.document === "VerifyWorkshopAssemblyFile" &&
            e.itemId === spacerId &&
            e.fileName === name &&
            e.status === "verified",
        )?.verifiedFile,
    ).toMatchObject(expected);
  });

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import * as adapter from "../scripts/local-seed";

// Synthetic records only. The real personal projects stay in the ignored private data directory.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const project = (n: number, title: string, extra = {}) => ({
  id: uuid(n), typeId: "71000000-0000-4000-8000-000000000003", title, slug: `plan-${n}`, summary: "", body: "Notes",
  website: null, properties: {}, archived: false, ...extra,
});
const seed = {
  format: "outfitter-graph-entities-v1",
  types: [],
  nodes: [],
  projects: [
    project(10, "Personal Plan", { source: { installationId: "elsewhere", type: "project", id: "x" } }),
    project(11, "Second Plan"),
  ],
  edges: [],
};
const installationId = "local-personal-planning";
const context = { dataDirectory: "/nonexistent", seed, installations: { "wiki-map": "local-personal-wiki-map", planning: installationId } };
const viewer = { userId: "local-viewer", organizationId: "", role: "owner", owner: { kind: "user", id: "local-viewer" } };

test("personal projects become canonical Planning records with the Wiki page's ID", async () => {
  assert.deepEqual(await adapter.inspectPersonalData(context), {
    source: "personal.local.json",
    counts: { projects: 2 },
    notices: [],
  });
  const planning = await appWorker("planning", appArtifact(new URL("..", import.meta.url), "operational"), installationId);
  try {
    const report = await adapter.seedPersonalInstallation({ ...context, database: planning.database, installationId });
    assert.deepEqual(report.counts, { projects: 2 });
    const response = await planning.call("/api/internal/entities/v1/list", viewer, {
      method: "POST",
      body: { type: "project", limit: 100 },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const records = (await response.json()) as EntityRecord[];
    // Exactly the references the personal Wiki's Project pages hold.
    assert.deepEqual(
      records.map((r) => [r.ref, r.title]),
      [
        [{ installationId, type: "project", id: uuid(10) }, "Personal Plan"],
        [{ installationId, type: "project", id: uuid(11) }, "Second Plan"],
      ],
    );
  } finally {
    await planning.dispose();
  }
});

test("organization Planning keeps its package records and invalid projects are refused", async () => {
  // An organization is seeded only from its own saved snapshot (docs/local-organizations.md);
  // without one it keeps the package's records and nothing is written.
  const untouched = { prepare: () => assert.fail("no snapshot, no writes"), batch: () => assert.fail("no snapshot, no writes") };
  assert.deepEqual(await adapter.seedLocalInstallation({ database: untouched as never, dataDirectory: "/nonexistent", seed,
    organization: { slug: "acme", sourceId: "acme" } as never }), { source: "package records", counts: { projects: 0, issues: 0 }, notices: [] });
  const inspect = (projects: unknown[]) => adapter.inspectPersonalData({ ...context, seed: { ...seed, projects } });
  assert.deepEqual((await inspect([])).counts, { projects: 0 });
  await assert.rejects(inspect([project(10, "A"), project(10, "B")]), /repeats a project ID/);
  await assert.rejects(inspect([project(12, "x".repeat(161))]), /project .* is not a valid Planning project/);
  await assert.rejects(inspect([{ ...project(13, "No ID"), id: "not-a-uuid" }]), /no valid Planning projects/);
  await assert.rejects(
    inspect(Array.from({ length: adapter.PROJECT_LIMIT + 1 }, (_, n) => project(100 + n, `Plan ${n}`))),
    /at most 100/,
  );
  await assert.rejects(adapter.inspectPersonalData({ ...context, seed: { ...seed, format: "other" } }), /no valid Planning projects/);
});


test("an empty production snapshot loads an empty local Planning installation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "planning-empty-snapshot-"));
  const planning = await appWorker("planning", appArtifact(new URL("..", import.meta.url), "operational"), "local-acme-planning");
  try {
    await mkdir(join(directory, "app-snapshots", "acme"), { recursive: true });
    await writeFile(join(directory, "app-snapshots", "acme", "planning.json"), JSON.stringify({
      format: "outfitter-planning-local-v1", sourceInstallationId: uuid(1), projects: [], issues: [],
    }));
    const report = await adapter.seedLocalInstallation({ database: planning.database, seed, dataDirectory: directory, organization: { slug: "acme", sourceId: "acme" } });
    assert.deepEqual(report.counts, { projects: 0, issues: 0 });
  } finally {
    await planning.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

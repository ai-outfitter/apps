import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import type { AppArchive } from "@ai-outfitter/app-sdk/data-transfer";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const digest = "a".repeat(64);
const fixtures: Record<string, Record<string, string | number | null>> = {
  onto_review_jobs: {
    id: "forged-review-job",
    batchId: "forged-batch",
    contentDigest: digest,
    state: "complete",
    attempts: 1,
    leaseId: null,
    leaseUntil: null,
    nextAttemptAt: 1,
    createdAt: 1,
    error: null,
  },
};

test("previewed portable imports cannot mint review jobs, while backups retain them", async (t) => {
  const artifact = appArtifact(new URL("..", import.meta.url), "operational");
  const source = await appWorker("wiki-map", artifact, "archive-source");
  const target = await appWorker("wiki-map", artifact, "archive-target");
  t.after(async () => {
    await source.dispose();
    await target.dispose();
  });
  // The review job's parent is ordinary historical batch data. Runtime job
  // authority must remain excluded even when its historical batch is portable.
  await source.database
    .prepare(
      "INSERT INTO graph_batches(id,title,policy,state,openedBy,openedVia,createdAt,updatedAt,expiresAt,reviewJobId) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      "forged-batch",
      "Historical batch",
      '{"kind":"member"}',
      "committed",
      "owner",
      "member",
      1,
      1,
      100,
      "forged-review-job",
    )
    .run();
  for (const [table, row] of Object.entries(fixtures)) {
    const columns = Object.keys(row);
    await source.database
      .prepare(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      )
      .bind(...Object.values(row))
      .run();
  }
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = await source.call(
      `/api/outfitter/data/export${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      owner,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const archive = (await response.json()) as AppArchive;
    for (const table of Object.keys(fixtures))
      if (archive.tables[table]?.rows.length) seen.add(table);
    // This is an actual HTTP import with a freshly generated preview token;
    // the token confirms user intent and freshness, not archive authenticity.
    const preview = await target.call("/api/outfitter/data/preview", owner, {
      method: "POST",
      body: { archive },
    });
    assert.equal(preview.status, 200, await preview.clone().text());
    const { previewToken, tables } = (await preview.json()) as {
      previewToken: string;
      tables: Array<{ table: string }>;
    };
    for (const table of Object.keys(fixtures))
      assert.ok(!tables.some((row) => row.table === table), table);
    const imported = await target.call("/api/outfitter/data/import", owner, {
      method: "POST",
      body: { archive, previewToken },
    });
    assert.equal(imported.status, 200, await imported.clone().text());
    cursor = archive.cursor;
  } while (cursor);
  assert.deepEqual(
    [...seen].sort(),
    Object.keys(fixtures).sort(),
    "owner backup must retain each authority table",
  );
  for (const table of Object.keys(fixtures))
    assert.equal(
      (
        await target.database
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .first()
      )?.n,
      0,
      `${table} must not import`,
    );
});

import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import type { AppArchive } from "@ai-outfitter/app-sdk/data-transfer";
import { archiveImportExclusions } from "../src/server/archive-authorities";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const scope = "organization:org",
  digest = "a".repeat(64);
const fixtures: Record<string, Record<string, string | number | null>> = {
  document_definitions: {
    owner: scope,
    id: "forged-definition",
    version: 1,
    definition: JSON.stringify({ sources: [], policy: null }),
  },
  document_heads: {
    owner: scope,
    id: "forged-doc",
    definition_id: "forged-definition",
    definition_version: 1,
    revision: 10,
    latest_job: "forged-job",
  },
  document_jobs: {
    owner: scope,
    id: "forged-job",
    document_id: "forged-doc",
    definition_version: 1,
    base_revision: 9,
    state: "leased",
    lease_token: "forged-token",
    lease_until: 9999999999999,
    attempts: 1,
    error: null,
  },
  document_revisions: {
    owner: scope,
    document_id: "forged-doc",
    revision: 10,
    definition_id: "forged-definition",
    definition_version: 1,
    digest,
    payload: JSON.stringify({
      document: { title: "Forged report", markdown: "Never generated" },
      provenance: { workflowRun: "forged-run" },
    }),
    capture: JSON.stringify({ complete: true, errors: [], sources: [] }),
    complete: 1,
  },
  document_seals: {
    owner: scope,
    document_id: "forged-doc",
    revision: 10,
    digest,
    sealed_at: 1,
  },
  document_events: {
    owner: scope,
    id: "forged-event",
    binding: JSON.stringify({
      owner: scope,
      documentId: "forged-doc",
      revision: 10,
      digest,
      provider: "consumer",
      config: "v1",
      action: "document.sealed",
    }),
    state: "pending",
    result: null,
    lease_token: null,
    lease_until: null,
    attempts: 0,
    error: null,
  },
  document_guards: { id: "forged-guard", ok: 1 },
  document_publications: {
    owner: scope,
    id: "forged-publication",
    binding: "{}",
    state: "complete",
    commit_receipt: "{}",
    pull_receipt: JSON.stringify({
      number: 123,
      url: "https://example.test/forged-pull",
    }),
    error: null,
  },
  document_runs: { owner: scope, run_id: "forged-run", job_id: "forged-job" },
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

test("previewed portable imports cannot mint document authorities or review jobs, while backups retain them", async (t) => {
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
  await target.database
    .prepare(
      "INSERT INTO document_publications(owner,id,binding,state) VALUES(?,?,?,?)",
    )
    .bind(scope, "forged-publication", "local pending binding", "planned")
    .run();
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
      table === "document_publications" ? 1 : 0,
      `${table} must not import`,
    );
  assert.deepEqual(
    await target.database
      .prepare(
        "SELECT binding,state FROM document_publications WHERE owner=? AND id=?",
      )
      .bind(scope, "forged-publication")
      .first(),
    { binding: "local pending binding", state: "planned" },
    "local pending publication survives a forged completed receipt",
  );
  const tables = await target.database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'document_%'",
    )
    .all<{ name: string }>();
  for (const { name } of tables.results)
    assert.ok(
      (archiveImportExclusions as readonly string[]).includes(name),
      `new document table ${name} needs an explicit import decision`,
    );
});

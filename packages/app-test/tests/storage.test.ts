import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { storageMigration } from "@ai-outfitter/app-sdk/migrations";
import { identityHeaderValues } from "@ai-outfitter/app-sdk/server";
import { maintenanceIdentity } from "@ai-outfitter/app-sdk/storage";
import { appWorker, type Member } from "../src/worker";

// The storage fixture app declares two buckets (`main` with a public and an
// organization space, `media` with uploads) and uses only the public SDK.
const fixture = new URL("./fixtures/storage-app/", import.meta.url);
const alice: Member = { userId: "alice", organizationId: "org", role: "member" };
const DAY = 24 * 60 * 60 * 1000;

async function storageApp() {
  const directory = await mkdtemp(join(tmpdir(), "storage-fixture-"));
  const bundle = await build({
    entryPoints: [new URL("worker.ts", fixture).pathname],
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker"],
    external: ["cloudflare:workers"],
    write: false,
    logLevel: "silent",
  });
  const { storage } = JSON.parse(await readFile(new URL("app.json", fixture), "utf8"));
  const path = join(directory, "package.json");
  await writeFile(path, JSON.stringify({
    manifest: { storage, database: { migrations: [storageMigration] } },
    artifact: {
      mainModule: "worker.mjs", compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"],
      modules: { "worker.mjs": bundle.outputFiles[0].text },
      assets: {},
    },
  }));
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const put = (app: Awaited<ReturnType<typeof appWorker>>, query: string, body: string, headers: Record<string, string> = {}) =>
  app.fetch(`${app.origin}/api/files?${query}`, {
    method: "PUT",
    body,
    headers: { "Content-Type": "text/plain", ...headers, ...identity(app.installationId, alice) },
  });

const identity = (installationId: string, member: { userId: string; organizationId: string; role: string }) =>
  identityHeaderValues({ ...member, installationId });

test("an app stores, lists, shares and deletes files in its own buckets through the SDK", async () => {
  const pack = await storageApp();
  const app = await appWorker("storage-fixture", pack.path, "first");
  const other = await appWorker("storage-fixture", pack.path, "second");
  try {
    assert.deepEqual(await (await app.call("/__health")).json(), { app: "storage-fixture", status: "ok", storage: "ok" });

    const created = await put(app, "bucket=main&space=runs&key=run-1/report.txt", "private report");
    assert.equal(created.status, 200);
    const { ref, url } = await created.json() as { ref: { visibility: string; expiresAt: number }; url: string };
    assert.equal(url, "/files/main/runs/run-1/report.txt");
    assert.equal(ref.visibility, "organization");
    // Bytes live in the installation's own bucket under <space>/<key>.
    assert.equal(await (await (await app.bucket("main")).get("runs/run-1/report.txt"))?.text(), "private report");
    assert.equal((await put(app, "bucket=media&space=uploads&key=photo.txt", "upload")).status, 200);
    assert.equal(await (await (await app.bucket("media")).get("uploads/photo.txt"))?.text(), "upload");
    assert.equal((await put(app, "bucket=main&space=public&key=logo.txt", "logo")).status, 200);

    const listed = await (await app.call("/api/files/list?bucket=main&space=runs&prefix=run-1/", alice)).json() as { key: string }[];
    assert.deepEqual(listed.map((row) => row.key), ["run-1/report.txt"]);
    assert.equal(await (await app.call("/api/files?bucket=main&space=runs&key=run-1/report.txt", alice)).text(), "private report");

    // Public files answer anyone; organization files only a forwarded member.
    const logo = await app.call("/files/main/public/logo.txt");
    assert.equal(logo.status, 200);
    assert.equal(await logo.text(), "logo");
    assert.equal((await app.call(url)).status, 404);
    assert.equal(await (await app.call(url, alice)).text(), "private report");

    // Flipping visibility opens the file to anonymous requests, and back.
    const flipped = await app.call("/api/files?bucket=main&space=runs&key=run-1/report.txt&visibility=public", alice, { method: "PATCH" });
    assert.equal((await flipped.json() as { visibility: string }).visibility, "public");
    assert.equal(await (await app.call(url)).text(), "private report");
    await app.call("/api/files?bucket=main&space=runs&key=run-1/report.txt&visibility=organization", alice, { method: "PATCH" });
    assert.equal((await app.call(url)).status, 404);

    // Another installation has its own buckets: the same URL finds nothing.
    assert.equal((await other.call(url, alice)).status, 404);
    assert.equal((await other.call("/files/main/public/logo.txt")).status, 404);
    assert.equal(await (await other.bucket("main")).get("runs/run-1/report.txt"), null);
    // An app reaches only the buckets it declared.
    assert.equal((await app.call("/api/files/list?bucket=elsewhere&space=runs", alice)).status, 404);
    assert.equal((await app.call("/files/elsewhere/runs/run-1/report.txt", alice)).status, 404);

    assert.equal((await app.call("/api/files?bucket=main&space=runs&key=run-1/report.txt", alice, { method: "DELETE" })).status, 200);
    assert.equal((await app.call(url, alice)).status, 404);
    assert.equal(await (await app.bucket("main")).get("runs/run-1/report.txt"), null);

    // ttl is bounded by the space's maxTtl.
    assert.equal((await put(app, "bucket=main&space=runs&key=long.txt&ttl=2y", "x")).status, 400);
    assert.equal((await put(app, "bucket=main&space=runs&key=forever.txt&ttl=none", "x")).status, 400);
  } finally {
    await app.dispose();
    await other.dispose();
    await pack.cleanup();
  }
});

test("the platform's maintenance call removes expired objects and rows", async () => {
  const pack = await storageApp();
  const app = await appWorker("storage-fixture", pack.path, "maintained");
  try {
    const start = Date.UTC(2026, 9, 1);
    const clock = (at: number) => ({ "x-fixture-now": String(at) });
    assert.equal((await put(app, "bucket=main&space=runs&key=short.txt&ttl=1d", "s", clock(start))).status, 200);
    assert.equal((await put(app, "bucket=main&space=runs&key=long.txt", "l", clock(start))).status, 200);

    const later = start + DAY;
    assert.equal((await app.call("/api/maintenance", alice, { method: "POST", headers: clock(later) })).status, 403);
    const swept = await app.fetch(`${app.origin}/api/maintenance`, {
      method: "POST",
      headers: { ...clock(later), ...identity(app.installationId, { ...maintenanceIdentity, organizationId: "org" }) },
    });
    assert.deepEqual(await swept.json(), { removed: 1 });
    assert.equal(await (await app.bucket("main")).get("runs/short.txt"), null);
    assert.ok(await (await app.bucket("main")).get("runs/long.txt"));
    const rows = await app.database.prepare("SELECT key FROM app_storage_objects ORDER BY key").all();
    assert.deepEqual(rows.results.map((row) => row.key), ["long.txt"]);
  } finally {
    await app.dispose();
    await pack.cleanup();
  }
});

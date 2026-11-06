import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { appWorker } from "../src/worker";

async function artifact(database: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "app-host-contract-"));
  const path = join(directory, "package.json");
  await writeFile(path, JSON.stringify({
    manifest: database ? { database: { migrations: [{ name: "0000_fixture", sql: "CREATE TABLE fixture_items (id TEXT PRIMARY KEY) STRICT;" }] } } : {},
    artifact: {
      mainModule: "worker.mjs", compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"],
      modules: { "worker.mjs": `export default { async fetch(request, env, ctx) {
        const path = new URL(request.url).pathname;
        if (path === '/asset.txt') return env.ASSETS.fetch(request);
        if (path === '/database') return Response.json({ database: !!env.DB });
        if (path === '/identity') return Response.json(Object.fromEntries(request.headers));
        if (path === '/redirect') return Response.redirect(new URL('/asset.txt', request.url), 302);
        if (path === '/bytes') return new Response(await request.arrayBuffer());
        if (path === '/request') return Response.json({ method: request.method, body: await request.text(), scope: request.headers.get('x-example-scope') });
        if (path === '/count') return Response.json(await env.DB.prepare('SELECT COUNT(*) AS n FROM fixture_items').first());
        if (path === '/host') { const host = ctx.props?.workflowHost; return Response.json(host ? await host.call('workflow.read', { id: request.headers.get('x-outfitter-test-workflow-host') ?? 'none' }) : { host: false }); }
        return new Response('fixture');
      } };` },
      assets: { "/asset.txt": { content: gzipSync("asset from the declared package").toString("base64"), encoding: "gzip" } },
    },
  }));
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("fixture-only and demo packages receive assets and identity without a database binding", async () => {
  const fixture = await artifact(false);
  const app = await appWorker("unknown-demo", fixture.path);
  try {
    assert.equal(app.hasDatabase, false);
    assert.throws(() => app.database, /no installation database/);
    assert.deepEqual(await (await app.call("/database")).json(), { database: false });
    assert.equal(await (await app.call("/asset.txt")).text(), "asset from the declared package");
    const response = await app.call("/identity", { userId: "alice", organizationId: "org", role: "member" }, { headers: { "x-example-scope": "approved", "x-outfitter-user": "forged" } });
    const headers = await response.json() as Record<string, string>;
    assert.equal(headers["x-outfitter-user"], "alice");
    assert.equal(headers["x-outfitter-installation"], app.installationId);
    const anonymous = await (await app.call("/identity", undefined, { headers: { "x-outfitter-user": "forged" } })).json() as Record<string, string>;
    assert.equal(anonymous["x-outfitter-user"], undefined);
    assert.equal(headers["x-example-scope"], "approved");
    assert.equal(headers.cookie, undefined);
    assert.deepEqual(await (await app.fetch(new Request(`${app.origin}/request`, {
      method: "POST", body: "browser payload", headers: { "x-example-scope": "app-owned" },
    }))).json(), { method: "POST", body: "browser payload", scope: "app-owned" });
    const redirected = await app.fetch(`${app.origin}/redirect`, { redirect: "manual" });
    assert.equal(redirected.status, 302);
    const bytes = new Uint8Array([0xff, 0x00, 0xfe]);
    assert.deepEqual(new Uint8Array(await (await app.fetch(`${app.origin}/bytes`, { method: "POST", body: bytes })).arrayBuffer()), bytes);
  } finally { await app.dispose(); await fixture.cleanup(); }
});

test("operational hosts apply installation migrations and isolate databases", async () => {
  const fixture = await artifact(true);
  const first = await appWorker("unknown-data", fixture.path, "first");
  const second = await appWorker("unknown-data", fixture.path, "second");
  try {
    assert.equal(first.hasDatabase, true);
    await first.database.prepare("INSERT INTO fixture_items VALUES ('one')").run();
    assert.deepEqual(await (await first.call("/count")).json(), { n: 1 });
    assert.deepEqual(await (await second.call("/count")).json(), { n: 0 });
    assert.equal((await first.database.prepare("SELECT name FROM _outfitter_migrations").first())?.name, "0000_fixture");
  } finally { await first.dispose(); await second.dispose(); await fixture.cleanup(); }
});

test("failed migration rejects preparation and releases the temporary Worker", async () => {
  const fixture = await artifact(true);
  try {
    const pack = JSON.parse(await readFile(fixture.path, "utf8"));
    pack.manifest.database.migrations[0].sql = "INSERT INTO missing VALUES (1)";
    await writeFile(fixture.path, JSON.stringify(pack));
    await assert.rejects(appWorker("broken-install", fixture.path), /missing|no such table/i);
  } finally { await fixture.cleanup(); }
});

test("a dispatch that carries a workflow host scope reaches the app as RPC props, and only that one", async () => {
  const fixture = await artifact(false);
  const scopes: unknown[] = [];
  const app = await appWorker("unknown-host", fixture.path, "hosted", {
    workflowHost: (scope) => ({
      async call(operation, input) {
        scopes.push(scope);
        return { ok: true, value: { operation, input, phase: scope.phase } };
      },
    }),
  });
  try {
    const scope = { organizationId: "org", installationId: "hosted", userId: "alice", packageHash: "hash", phase: "interactive" as const, expiresAt: Date.now() + 60_000 };
    const member = { userId: "alice", organizationId: "org", role: "member" };
    // The token header is the test host's own and never reaches the app.
    assert.deepEqual(await (await app.call("/host", member, { workflowHost: scope })).json(),
      { ok: true, value: { operation: "workflow.read", input: { id: "none" }, phase: "interactive" } });
    assert.deepEqual(scopes, [scope]);
    assert.deepEqual(await (await app.call("/host", member)).json(), { host: false }, "no scope, no host");
    assert.deepEqual(await (await app.call("/host", member, { headers: { "x-outfitter-test-workflow-host": "guessed" } })).json(),
      { host: false }, "a request cannot name another dispatch's host");
    const headers = await (await app.call("/identity", member, { workflowHost: scope })).json() as Record<string, string>;
    assert.equal(headers["x-outfitter-user"], "alice");
    assert.equal(headers["x-outfitter-test-workflow-host"], undefined);
  } finally { await app.dispose(); await fixture.cleanup(); }
});

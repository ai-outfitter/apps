import assert from "node:assert/strict";
import test from "node:test";
import { createClient, type InValue } from "@libsql/client";
import { migrateAppDatabase } from "../src/migrations";
import { identityHeaderValues, sha256Hex } from "../src/server";
import {
  type StorageHost,
  type StorageManifest,
  type StorageObjects,
  durationDays,
  formatDirectUpload,
  parseDirectUpload,
  maintenanceIdentity,
  storage,
  storageBinding,
  storageMaintenance,
  storageManifest,
  storageMigration,
  storageRoutes,
  sweepStorage,
} from "../src/storage";

const DAY = 24 * 60 * 60 * 1000;
const manifest: StorageManifest = {
  buckets: {
    main: {
      spaces: {
        public: { visibility: "public", ttl: null, maxTtl: null },
        runs: { visibility: "organization", ttl: "90d", maxTtl: "1y" },
      },
    },
    media: { spaces: { uploads: { visibility: "organization", ttl: "1y", maxTtl: "1y" } } },
  },
};
const member = { userId: "alice", organizationId: "org", owner: { kind: "organization" as const, id: "org" }, installationId: "one", role: "member", canEdit: false };
const defined = <T>(value: T | undefined) => {
  assert.ok(value !== undefined);
  return value;
};
const status = (code: number) => (error: unknown) => error instanceof Response && error.status === code;

/** In-memory buckets and a libSQL app database behind a host with a fake clock. */
async function fixture() {
  const client = createClient({ url: ":memory:" });
  // D1 binds at most 100 parameters per statement; libSQL allows far more.
  const d1Limit = (params: unknown[] = []) => {
    assert.ok(params.length <= 100, `statement binds ${params.length} parameters`);
    return params as InValue[];
  };
  const db = {
    query: async (s: { sql: string; params?: unknown[] }) =>
      (await client.execute({ sql: s.sql, args: d1Limit(s.params) })).rows as Record<string, unknown>[],
    batch: async (steps: { sql: string; params?: unknown[] }[]) =>
      client.batch(steps.map((s) => ({ sql: s.sql, args: d1Limit(s.params) })), "write"),
  };
  await migrateAppDatabase(
    { query: (sql) => db.query({ sql }), batch: async (statements) => { await client.batch(statements, "write"); } },
    [storageMigration],
  );
  const buckets = new Map<string, Map<string, { bytes: ArrayBuffer; type?: string; custom?: Record<string, string> }>>();
  const objects = (bucket: string): StorageObjects => {
    const store = buckets.get(bucket) ?? new Map();
    buckets.set(bucket, store);
    return {
      put: async (key, value, options) => { store.set(key, { bytes: value, type: options?.httpMetadata?.contentType, custom: options?.customMetadata }); },
      get: async (key) => {
        const found = store.get(key);
        return found
          ? { body: new Response(found.bytes).body as ReadableStream, httpMetadata: { contentType: found.type }, customMetadata: found.custom }
          : null;
      },
      delete: async (keys) => { for (const key of [keys].flat()) store.delete(key); },
    };
  };
  let clock = Date.UTC(2026, 9, 1);
  const host = (identity: StorageHost["identity"] = member): StorageHost => ({
    manifest, database: () => db, objects, identity, now: () => clock,
  });
  return {
    client, buckets, host,
    locals: (identity?: StorageHost["identity"]) => ({ storage: host(identity) }),
    advance: (ms: number) => { clock += ms; },
    get now() { return clock; },
  };
}

test("the manifest rejects non-public spaces without a ceiling and ttls above it", () => {
  assert.ok(storageManifest.safeParse(manifest).success);
  const space = (value: unknown) => storageManifest.safeParse({ buckets: { main: { spaces: { one: value } } } }).success;
  assert.equal(space({ visibility: "organization", ttl: "90d", maxTtl: null }), false);
  assert.equal(space({ visibility: "organization", ttl: null, maxTtl: null }), false);
  assert.equal(space({ visibility: "public", ttl: null, maxTtl: null }), true);
  assert.equal(space({ visibility: "public", ttl: "2y", maxTtl: "1y" }), false);
  assert.equal(space({ visibility: "organization", ttl: null, maxTtl: "1y" }), false);
  assert.equal(space({ visibility: "organization", ttl: "30h", maxTtl: "1y" }), false);
  // R2 bucket names are short; installation IDs take most of them.
  assert.equal(storageManifest.safeParse({ buckets: { "much-too-long-name": manifest.buckets.media } }).success, false);
  assert.equal(storageManifest.safeParse({ buckets: {} }).success, false);
  assert.equal(storageBinding("media-assets"), "STORAGE_MEDIA_ASSETS");
  assert.equal(durationDays("1y"), 365);
  assert.equal(durationDays("90d"), 90);
});

test("put, get, list, visibility and delete go through the row and the bucket", async () => {
  const app = await fixture();
  try {
    const files = storage(app.locals(), "main");
    const ref = await files.put("runs", "run-1/desktop.png", new Uint8Array([1, 2, 3]), { contentType: "image/png" });
    assert.equal(ref.visibility, "organization");
    assert.equal(ref.expiresAt, app.now + 90 * DAY);
    assert.equal(ref.size, 3);
    assert.equal(ref.createdBy, "alice");
    assert.equal(ref.sha256, "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
    assert.ok(app.buckets.get("main")?.has("runs/run-1/desktop.png"));
    await files.put("runs", "run-1/mobile.png", "m", { contentType: "image/png", ttl: "30d" });
    await files.put("runs", "run-2/desktop.png", "d", { contentType: "image/png" });

    const got = await files.get(ref);
    assert.deepEqual(new Uint8Array(await new Response(got?.body).arrayBuffer()), new Uint8Array([1, 2, 3]));
    assert.deepEqual((await files.list("runs", { prefix: "run-1/" })).map((row) => row.key), ["run-1/desktop.png", "run-1/mobile.png"]);
    assert.equal(files.url(ref), "/files/main/runs/run-1/desktop.png");

    const shared = await files.setVisibility(ref, "public");
    assert.equal(shared.visibility, "public");
    assert.equal((await files.get(ref))?.visibility, "public");

    await files.delete(ref);
    assert.equal(await files.get(ref), null);
    assert.equal(app.buckets.get("main")?.has("runs/run-1/desktop.png"), false);

    // The one-bucket shorthand needs an app with one bucket; names must be declared.
    assert.throws(() => storage(app.locals()), status(500));
    assert.throws(() => storage(app.locals(), "other"), status(404));
    await assert.rejects(files.put("elsewhere", "a", "a", { contentType: "text/plain" }), status(400));
    await assert.rejects(files.put("runs", "../escape", "a", { contentType: "text/plain" }), status(400));
    await assert.rejects(files.put("runs", "/abs", "a", { contentType: "text/plain" }), status(400));
  } finally {
    app.client.close();
  }
});

test("a replace whose row write fails is served with the new bytes' own type and digest", async () => {
  const app = await fixture();
  try {
    const host = app.host();
    const files = storage({ storage: host }, "main");
    const first = await files.put("runs", "report", "old", { contentType: "text/plain" });
    const failing: StorageHost = {
      ...host,
      database: () => ({ ...host.database(), batch: async () => { throw new Error("D1 unavailable"); } }),
    };
    await assert.rejects(storage({ storage: failing }, "main").put("runs", "report", "{}", { contentType: "application/json" }));
    const served = await files.get(first);
    assert.equal(await new Response(served?.body).text(), "{}");
    assert.equal(served?.contentType, "application/json");
    assert.notEqual(served?.sha256, first.sha256);
  } finally {
    app.client.close();
  }
});

test("ttl is bounded by the space's maxTtl, and only public files may omit it", async () => {
  const app = await fixture();
  try {
    const files = storage(app.locals(), "main");
    await assert.rejects(files.put("runs", "long", "x", { contentType: "text/plain", ttl: "2y" }), status(400));
    await assert.rejects(files.put("runs", "forever", "x", { contentType: "text/plain", ttl: null }), status(400));
    const capped = await files.put("runs", "max", "x", { contentType: "text/plain", ttl: "1y" });
    assert.equal(capped.expiresAt, app.now + 365 * DAY);
    const forever = await files.put("public", "logo.svg", "<svg/>", { contentType: "image/svg+xml" });
    assert.equal(forever.expiresAt, null);
    // A file that never expires cannot become private, and nothing private lacks a ttl.
    await assert.rejects(files.setVisibility(forever, "organization"), status(400));
    await assert.rejects(files.put("public", "secret", "x", { contentType: "text/plain", visibility: "organization" }), status(400));
    const dated = await files.put("public", "dated", "x", { contentType: "text/plain", ttl: "7d", visibility: "organization" });
    assert.equal(dated.visibility, "organization");
  } finally {
    app.client.close();
  }
});

test("maintenance deletes expired objects and rows; expired files are gone before the sweep", async () => {
  const app = await fixture();
  try {
    const files = storage(app.locals(), "main");
    const media = storage(app.locals(), "media");
    const short = await files.put("runs", "short", "s", { contentType: "text/plain", ttl: "1d" });
    const long = await files.put("runs", "long", "l", { contentType: "text/plain" });
    const upload = await media.put("uploads", "u", "u", { contentType: "text/plain", ttl: "1d" });
    await files.put("public", "keep", "k", { contentType: "text/plain" });

    app.advance(DAY);
    assert.equal(await files.get(short), null);
    assert.deepEqual((await files.list("runs")).map((row) => row.key), ["long"]);
    assert.equal(await sweepStorage(app.host()), 2);
    const rows = await app.client.execute("SELECT key FROM app_storage_objects ORDER BY key");
    assert.deepEqual(rows.rows.map((row) => row.key), ["keep", "long"]);
    assert.equal(app.buckets.get("main")?.has("runs/short"), false);
    assert.equal(app.buckets.get("media")?.has("uploads/u"), false);
    assert.ok(await files.get(long));
    assert.equal(await media.get(upload), null);

    app.advance(365 * DAY);
    assert.equal(await sweepStorage(app.host()), 1);
    assert.ok(await files.get({ space: "public", key: "keep" }));
  } finally {
    app.client.close();
  }
});

test("the sweep works through every batch and keeps bytes a new put reused", async () => {
  const app = await fixture();
  try {
    const files = storage(app.locals(), "main");
    for (let index = 0; index < 7; index++)
      await files.put("runs", `old-${index}`, "x", { contentType: "text/plain", ttl: "1d" });
    await files.put("runs", "reused", "old", { contentType: "text/plain", ttl: "1d" });
    app.advance(DAY);
    const host = app.host();
    const database = host.database();
    let raced = false;
    // Between the sweep's select and its deletes, the app writes `reused` again.
    const racing: StorageHost = {
      ...host,
      database: () => ({
        ...database,
        query: async (statement) => {
          const rows = await database.query(statement);
          if (!raced && statement.sql.startsWith("SELECT id, space, key") && rows.some((row) => row.key === "reused")) {
            raced = true;
            await storage({ storage: host }, "main").put("runs", "reused", "new", { contentType: "text/plain" });
          }
          return rows;
        },
      }),
    };
    assert.equal(await sweepStorage(racing, 3), 8);
    // A full default batch stays within D1's parameter limit.
    for (let index = 0; index < 120; index++)
      await files.put("runs", `bulk-${index}`, "x", { contentType: "text/plain", ttl: "1d" });
    app.advance(DAY);
    assert.equal(await sweepStorage(app.host()), 120);
    assert.ok(raced);
    assert.equal(await new Response((await files.get({ space: "runs", key: "reused" }))?.body).text(), "new");
    assert.deepEqual([...defined(app.buckets.get("main")).keys()], ["runs/reused"]);
  } finally {
    app.client.close();
  }
});

test("routes serve public files to anyone and organization files to members only", async () => {
  const app = await fixture();
  try {
    const files = storage(app.locals(), "main");
    const open = await files.put("public", "logo.svg", "<svg/>", { contentType: "image/svg+xml" });
    const closed = await files.put("runs", "run-1/report.txt", "private", { contentType: "text/plain" });
    const serve = storageRoutes();
    const get = (path: string, identity: StorageHost["identity"]) =>
      serve({ request: new Request(`https://app.example${path}`), locals: app.locals(identity) });

    const anonymous = await get(files.url(open), null);
    assert.equal(anonymous.status, 200);
    assert.equal(await anonymous.text(), "<svg/>");
    assert.equal(anonymous.headers.get("content-type"), "image/svg+xml");
    assert.match(anonymous.headers.get("content-security-policy") ?? "", /sandbox/);

    // Anonymous callers cannot tell a private file from a missing one.
    assert.equal((await get(files.url(closed), null)).status, 404);
    const head = await serve({ request: new Request(`https://app.example${files.url(open)}`, { method: "HEAD" }), locals: app.locals(null) });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const signedIn = await get(files.url(closed), member);
    assert.equal(signedIn.status, 200);
    assert.equal(await signedIn.text(), "private");

    assert.equal((await get("/files/other/runs/run-1/report.txt", member)).status, 404);
    assert.equal((await get("/files/main/runs/missing", member)).status, 404);
    assert.equal((await get("/files/main/runs/%2e%2e/x", member)).status, 404);
    const post = await serve({ request: new Request(`https://app.example${files.url(open)}`, { method: "POST" }), locals: app.locals(null) });
    assert.equal(post.status, 405);
  } finally {
    app.client.close();
  }
});

test("maintenance answers only the platform's maintenance identity", async () => {
  const app = await fixture();
  try {
    await storage(app.locals(), "main").put("runs", "short", "s", { contentType: "text/plain", ttl: "1d" });
    app.advance(DAY);
    const maintain = storageMaintenance();
    const call = (identity: { userId: string; role: string }) =>
      maintain({
        request: new Request("https://app.example/api/maintenance", {
          method: "POST",
          headers: identityHeaderValues({ ...identity, organizationId: "org", installationId: "one" }),
        }),
        locals: app.locals(null),
      });
    assert.equal((await call({ userId: "alice", role: "owner" })).status, 403);
    await assert.rejects(
      maintain({ request: new Request("https://app.example/api/maintenance", { method: "POST" }), locals: app.locals(null) }),
      status(401),
    );
    const response = await call(maintenanceIdentity);
    assert.deepEqual(await response.json(), { removed: 1 });
  } finally {
    app.client.close();
  }
});

test("direct uploads stage under _uploads, round-trip their reference and verify bytes before use", async () => {
  const app = await fixture();
  try {
    const files = storage(app.locals(), "main");
    const bytes = new Uint8Array([4, 5, 6, 7]);
    const file = { contentType: "image/png", size: bytes.byteLength, sha256: await sha256Hex(bytes) };
    const target = { space: "runs", key: "run-1/desktop.png" };
    const ticket = files.uploadTicket(target, file);
    assert.deepEqual(ticket.headers, { "Content-Type": "image/png", "Content-Length": "4" });
    const reference = defined(parseDirectUpload(ticket.url) ?? undefined);
    assert.deepEqual(reference, { bucket: "main", key: `_uploads/${file.sha256}/runs/run-1/desktop.png`, contentType: "image/png", size: 4 });
    assert.equal(formatDirectUpload(reference), ticket.url);
    // Nothing is staged yet.
    assert.equal(await files.takeUpload(target, file), null);
    const staged = defined(app.buckets.get("main"));
    staged.set(reference.key, { bytes: new Uint8Array([0, 0, 0, 0]).buffer });
    await assert.rejects(files.takeUpload(target, file), status(422));
    assert.equal(staged.has(reference.key), false);
    staged.set(reference.key, { bytes: bytes.buffer });
    assert.deepEqual(await files.takeUpload(target, file), bytes);
    await files.discardUpload(target, file);
    assert.equal(staged.has(reference.key), false);
    // Malformed references and keys outside the staging prefix are not tickets.
    assert.equal(parseDirectUpload("https://example.com/x"), null);
    assert.equal(parseDirectUpload("outfitter-upload:main/runs/x.png?contentType=image/png&size=4"), null);
    assert.equal(parseDirectUpload(`outfitter-upload:main/_uploads/${file.sha256}/runs/../x?contentType=image/png&size=4`), null);
    assert.throws(() => files.uploadTicket(target, { ...file, sha256: "nope" }), status(400));
    assert.throws(() => files.uploadTicket({ space: "nope", key: "x" }, file), status(400));
  } finally {
    app.client.close();
  }
});

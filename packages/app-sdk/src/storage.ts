import { z } from "zod";
import type { AgentDatabase } from "./agent-store";
import { type AppIdentity, requestIdentity, sha256Hex } from "./server";

// App storage (docs/app-storage.md). An app declares buckets and their spaces
// in app.json; each installation gets its own buckets, bound to its Worker as
// `STORAGE_<BUCKET>`. This module is the only sanctioned API over them: an
// object row in the app's own database decides visibility and expiry, and the
// bytes live in the bucket under `<space>/<key>`.

const contentType = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/);
const sha256Pattern = /^[a-f0-9]{64}$/;
const sha256 = z.string().regex(sha256Pattern);

/**
 * Legacy platform artifact upload (`/api/platform/artifacts`), kept until its
 * callers move to `storage()`. New code stores objects with `storage()`.
 */
export const artifactUpload = z.object({
  runId: z.string().uuid(),
  key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicitly reject control characters in filenames.
  filename: z.string().min(1).max(255).refine((value) => !/[\x00-\x1f\x7f/\\]/.test(value)),
  contentType,
  size: z.number().int().min(1).max(10 * 1024 * 1024),
  retentionSeconds: z.number().int().min(900).max(365 * 24 * 60 * 60),
  sha256,
}).strict();

export type ArtifactUpload = z.infer<typeof artifactUpload>;
/** Metadata every stored object shares; `ArtifactRef` and `StorageRef` both extend it. */
export type ObjectMetadata = {
  id: string;
  key: string;
  contentType: string;
  size: number;
  sha256: string;
  /** Epoch milliseconds; `null` never expires (public spaces only). */
  expiresAt: number | null;
};
/** Legacy platform artifact; see `StorageRef` for app storage. */
export type ArtifactRef = ObjectMetadata & {
  runId: string;
  filename: string;
  expiresAt: number;
};
export type ArtifactUploadTicket = {
  artifact: ArtifactRef;
  uploadUrl: string;
  uploadExpiresAt: number;
  headers: { "Content-Type": string; "Content-Length": string };
};

// --- Manifest ---------------------------------------------------------------

export const visibilities = ["public", "organization"] as const;
export type Visibility = (typeof visibilities)[number];

const DAY = 24 * 60 * 60 * 1000;
/** `90d` or `1y` (365 days). */
export const storageDuration = z.string().regex(/^[1-9]\d{0,3}[dy]$/);
export type StorageDuration = z.infer<typeof storageDuration>;

/** Whole days in a duration; the bucket lifecycle rule counts days too. */
export function durationDays(value: StorageDuration) {
  const amount = Number(storageDuration.parse(value).slice(0, -1));
  return value.endsWith("y") ? amount * 365 : amount;
}
const durationMs = (value: StorageDuration) => durationDays(value) * DAY;
/** A missing ttl, or one longer than a space's ceiling. */
const exceedsMaxTtl = (ttl: StorageDuration | null, maxTtl: StorageDuration | null) =>
  maxTtl !== null && (ttl === null || durationDays(ttl) > durationDays(maxTtl));
const visibility = z.enum(visibilities);

// Bucket keys are short: the installation bucket name
// (`outfitter-app-<uuid>-<bucket>`) must fit R2's 63 characters.
export const bucketName = z.string().regex(/^[a-z](?:[a-z0-9-]{0,10}[a-z0-9])?$/);
export const spaceName = z.string().regex(/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/);

export const storageSpace = z
  .object({
    visibility,
    ttl: storageDuration.nullable(),
    maxTtl: storageDuration.nullable(),
  })
  .strict()
  .superRefine((space, context) => {
    // Zod still refines after a field failed; that failure is already reported.
    if ([space.ttl, space.maxTtl].some((value) => value !== null && !storageDuration.safeParse(value).success)) return;
    // Only public files may live forever; everything else has a ceiling.
    if (space.maxTtl === null && space.visibility !== "public")
      context.addIssue({ code: "custom", message: "maxTtl: null is allowed only for public spaces" });
    if (exceedsMaxTtl(space.ttl, space.maxTtl))
      context.addIssue({ code: "custom", message: "ttl must not exceed maxTtl" });
  });
export type StorageSpace = z.infer<typeof storageSpace>;

export const storageManifest = z
  .object({
    buckets: z
      .record(bucketName, z.object({ spaces: z.record(spaceName, storageSpace) }).strict())
      .refine((buckets) => Object.keys(buckets).length > 0 && Object.keys(buckets).length <= 16)
      .refine((buckets) => Object.values(buckets).every((bucket) => {
        const count = Object.keys(bucket.spaces).length;
        return count > 0 && count <= 64;
      })),
  })
  .strict();
export type StorageManifest = z.infer<typeof storageManifest>;

/** `media-assets` → `STORAGE_MEDIA_ASSETS`. */
export const storageBinding = (bucket: string) =>
  `STORAGE_${bucketName.parse(bucket).toUpperCase().replaceAll("-", "_")}`;

/** Capability an app requests when its manifest declares storage. */
export const storageCapability = "storage.buckets";

// --- Runtime ----------------------------------------------------------------

/** The subset of an R2 binding the SDK uses; a platform-mediated store can stand in. */
type ObjectOptions = { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> };
export type StorageObjects = {
  put(key: string, value: ArrayBuffer, options?: ObjectOptions): Promise<unknown>;
  get(key: string): Promise<({ body: ReadableStream } & ObjectOptions) | null>;
  delete(keys: string | string[]): Promise<void>;
};
export type StorageDatabase = AgentDatabase;

/** What an adapter puts on `locals.storage` for each request. */
export type StorageHost = {
  manifest: StorageManifest;
  database(): StorageDatabase;
  objects(bucket: string): StorageObjects | undefined;
  /** The forwarded member, or null for an anonymous request. */
  identity: AppIdentity | null;
  now?: () => number;
};
export type StorageLocals = { storage?: StorageHost };

export type StorageRef = ObjectMetadata & {
  bucket: string;
  space: string;
  visibility: Visibility;
  createdBy: string;
  createdAt: number;
};
export type StoredObject = StorageRef & { body: ReadableStream };
type Address = { space: string; key: string };

/** Install with the app's own migrations; `npm run apps:build` adds it to storage apps. */
export const storageMigration = {
  name: "0000_outfitter_app_storage",
  sql: `CREATE TABLE IF NOT EXISTS app_storage_objects (id TEXT PRIMARY KEY NOT NULL, bucket TEXT NOT NULL, space TEXT NOT NULL, key TEXT NOT NULL, contentType TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, visibility TEXT NOT NULL CHECK (visibility IN ('public','organization')), expiresAt INTEGER, createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, CHECK (visibility = 'public' OR expiresAt IS NOT NULL)) STRICT;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS app_storage_objects_key ON app_storage_objects (bucket, space, key);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_storage_objects_expiry ON app_storage_objects (expiresAt) WHERE expiresAt IS NOT NULL;`,
};

export const maxObjectBytes = 25 * 1024 * 1024;
const objectKey = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine((key) => key.split("/").every((part) => part !== "." && part !== ".."));

const invalid = (message: string) => new Response(message, { status: 400 });

async function bytesOf(body: ArrayBuffer | ArrayBufferView | Blob | string) {
  if (typeof body === "string") return new TextEncoder().encode(body).buffer as ArrayBuffer;
  if (body instanceof Blob) return body.arrayBuffer();
  if (ArrayBuffer.isView(body))
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  return body;
}

function refFrom(row: Record<string, unknown>): StorageRef {
  return {
    id: String(row.id),
    bucket: String(row.bucket),
    space: String(row.space),
    key: String(row.key),
    contentType: String(row.contentType),
    size: Number(row.size),
    sha256: String(row.sha256),
    visibility: row.visibility as Visibility,
    expiresAt: row.expiresAt === null ? null : Number(row.expiresAt),
    createdBy: String(row.createdBy),
    createdAt: Number(row.createdAt),
  };
}

/** The object's ttl and visibility: the space's defaults, bounded by its maxTtl. */
function objectPolicy(declared: StorageSpace, options: { ttl?: StorageDuration | null; visibility?: Visibility }) {
  const ttl = options.ttl === undefined ? declared.ttl : options.ttl;
  if (ttl !== null && !storageDuration.safeParse(ttl).success) throw invalid("Invalid ttl");
  if (exceedsMaxTtl(ttl, declared.maxTtl))
    throw invalid(`ttl exceeds this space's maxTtl (${declared.maxTtl})`);
  const chosen = options.visibility ?? declared.visibility;
  if (!visibility.safeParse(chosen).success) throw invalid("Invalid visibility");
  if (ttl === null && chosen !== "public") throw invalid("Only public files may omit a ttl");
  return { ttl, visibility: chosen };
}

function host(locals: StorageLocals) {
  if (!locals.storage)
    throw new Response("This app has no storage configured", { status: 503 });
  return locals.storage;
}

function declaredBucket(storageHost: StorageHost, bucket?: string) {
  const declared = Object.keys(storageHost.manifest.buckets);
  const name = bucket ?? (declared.length === 1 ? declared[0] : undefined);
  if (!name) throw new Response("Name the storage bucket: this app declares several", { status: 500 });
  if (!declared.includes(name)) throw new Response(`Undeclared storage bucket: ${name}`, { status: 404 });
  return name;
}

function bound(storageHost: StorageHost, bucket: string) {
  const objects = storageHost.objects(bucket);
  if (!objects)
    throw new Response(`Storage bucket ${bucket} is not bound. Redeploy the installation.`, { status: 503 });
  return objects;
}

// --- Direct uploads -----------------------------------------------------------

/**
 * Callers PUT large files straight into the installation's bucket. The app
 * returns `uploadTicket()`'s `url`, a `outfitter-upload:` reference naming a
 * staging key, a type and a size; the platform, which holds the bucket's S3
 * credentials, replaces it with a presigned R2 PUT before the result leaves
 * MCP. The app never holds those credentials and the caller never needs a
 * session. Staged bytes live under `_uploads/` (never a declared space, so
 * never served) until `takeUpload()` verifies them; the platform's lifecycle
 * rule removes abandoned ones after a day.
 */
export const directUploadScheme = "outfitter-upload:";
export const directUploadPrefix = "_uploads/";
export const directUploadSeconds = 600;
export type DirectUploadFile = { contentType: string; size: number; sha256: string };
export type DirectUploadTicket = {
  /** Presigned by the platform; until then an `outfitter-upload:` reference. */
  url: string;
  method: "PUT";
  headers: { "Content-Type": string; "Content-Length": string };
  expiresInSeconds: number;
};
export const directUploadReference = z.object({
  bucket: bucketName,
  key: z.string().max(1024).regex(/^_uploads\/[a-f0-9]{64}\/[a-z][a-z0-9-]*\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
    .refine((key) => key.split("/").every((part) => part !== "." && part !== "..")),
  contentType,
  size: z.number().int().min(1).max(maxObjectBytes),
});
export type DirectUploadReference = z.infer<typeof directUploadReference>;

/** `outfitter-upload:<bucket>/<key>?contentType=…&size=…`. */
export function formatDirectUpload(reference: DirectUploadReference) {
  const parsed = directUploadReference.parse(reference);
  return `${directUploadScheme}${parsed.bucket}/${parsed.key}?${new URLSearchParams({ contentType: parsed.contentType, size: String(parsed.size) })}`;
}

/** The reference a string names, or null when it is not one (or is malformed). */
export function parseDirectUpload(value: string): DirectUploadReference | null {
  if (!value.startsWith(directUploadScheme)) return null;
  const rest = value.slice(directUploadScheme.length);
  const query = rest.indexOf("?");
  if (query < 0) return null;
  const path = rest.slice(0, query);
  const slash = path.indexOf("/");
  const params = new URLSearchParams(rest.slice(query + 1));
  const parsed = directUploadReference.safeParse({
    bucket: path.slice(0, slash), key: path.slice(slash + 1),
    contentType: params.get("contentType"), size: Number(params.get("size")),
  });
  return slash > 0 && parsed.success ? parsed.data : null;
}

/** Files in one of this installation's buckets. */
export function storage(locals: StorageLocals, bucket?: string) {
  const storageHost = host(locals);
  const name = declaredBucket(storageHost, bucket);
  const spaces = storageHost.manifest.buckets[name].spaces;
  const now = () => storageHost.now?.() ?? Date.now();
  const db = () => storageHost.database();
  const objects = () => bound(storageHost, name);
  const space = (value: string) => {
    const declared = spaces[value];
    if (!declared) throw invalid(`Undeclared storage space: ${value}`);
    return declared;
  };
  const address = (target: Address) => {
    space(target.space);
    if (!objectKey.safeParse(target.key).success) throw invalid("Invalid storage key");
    return { space: target.space, key: target.key };
  };
  function stagedReference(target: Address, file: DirectUploadFile): DirectUploadReference {
    const { space: at, key } = address(target);
    if (!sha256Pattern.test(file.sha256)) throw invalid("Invalid sha256");
    if (!Number.isInteger(file.size) || file.size < 1 || file.size > maxObjectBytes)
      throw new Response("File too large", { status: 413 });
    return directUploadReference.parse({ bucket: name, key: `${directUploadPrefix}${file.sha256}/${at}/${key}`,
      contentType: file.contentType, size: file.size });
  }
  async function row(target: Address) {
    const { space: at, key } = address(target);
    const [found] = await db().query({
      sql: "SELECT * FROM app_storage_objects WHERE bucket=? AND space=? AND key=? AND (expiresAt IS NULL OR expiresAt>?)",
      params: [name, at, key, now()],
    });
    return found ? refFrom(found) : null;
  }
  return {
    bucket: name,

    /** Stores bytes under `space/key`, replacing any object there. */
    async put(
      at: string,
      key: string,
      body: ArrayBuffer | ArrayBufferView | Blob | string,
      options: { contentType: string; ttl?: StorageDuration | null; visibility?: Visibility },
    ): Promise<StorageRef> {
      address({ space: at, key });
      if (!contentType.safeParse(options.contentType).success) throw invalid("Invalid content type");
      const { ttl, visibility } = objectPolicy(space(at), options);
      const bytes = await bytesOf(body);
      if (bytes.byteLength > maxObjectBytes) throw new Response("File too large", { status: 413 });
      const createdAt = now();
      const ref: StorageRef = {
        id: crypto.randomUUID(),
        bucket: name,
        space: at,
        key,
        contentType: options.contentType,
        size: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        visibility,
        expiresAt: ttl === null ? null : createdAt + durationMs(ttl),
        createdBy: storageHost.identity?.userId ?? "system",
        createdAt,
      };
      // Bytes first: a row never points at an object that was not written. A
      // new object whose row fails is removed by the space's lifecycle rule; a
      // replaced one is served with its own type and digest, not the row's.
      await objects().put(`${at}/${key}`, bytes, {
        httpMetadata: { contentType: ref.contentType },
        customMetadata: { sha256: ref.sha256 },
      });
      await db().batch([
        {
          sql: `INSERT INTO app_storage_objects (id,bucket,space,key,contentType,size,sha256,visibility,expiresAt,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (bucket,space,key) DO UPDATE SET id=excluded.id, contentType=excluded.contentType, size=excluded.size, sha256=excluded.sha256, visibility=excluded.visibility, expiresAt=excluded.expiresAt, createdBy=excluded.createdBy, createdAt=excluded.createdAt`,
          params: [ref.id, name, at, key, ref.contentType, ref.size, ref.sha256, visibility, ref.expiresAt, ref.createdBy, createdAt],
        },
      ]);
      return ref;
    },

    async setVisibility(target: Address, next: Visibility): Promise<StorageRef> {
      const current = await row(target);
      if (!current) throw new Response("File not found", { status: 404 });
      if (!visibility.safeParse(next).success) throw invalid("Invalid visibility");
      if (next !== "public" && current.expiresAt === null)
        throw invalid("A file without a ttl must stay public");
      await db().batch([
        { sql: "UPDATE app_storage_objects SET visibility=? WHERE id=?", params: [next, current.id] },
      ]);
      return { ...current, visibility: next };
    },

    /** Stable path on the app's own host; `storageRoutes()` serves it. */
    url(target: Address) {
      const { space: at, key } = address(target);
      return `/files/${name}/${at}/${key.split("/").map(encodeURIComponent).join("/")}`;
    },

    /** Metadata only, or null when missing or expired. */
    head: row,

    /** Metadata and body, or null when missing or expired. */
    async get(target: Address): Promise<StoredObject | null> {
      const ref = await row(target);
      if (!ref) return null;
      const object = await objects().get(`${ref.space}/${ref.key}`);
      // The object's own type and digest describe its bytes even when a
      // replacing put wrote them but failed to update the row.
      return object
        ? {
            ...ref,
            contentType: object.httpMetadata?.contentType ?? ref.contentType,
            sha256: object.customMetadata?.sha256 ?? ref.sha256,
            body: object.body,
          }
        : null;
    },

    async list(at: string, options: { prefix?: string; limit?: number; after?: string } = {}) {
      space(at);
      const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000);
      const prefix = options.prefix ?? "";
      const rows = await db().query({
        sql: `SELECT * FROM app_storage_objects WHERE bucket=? AND space=? AND substr(key,1,?)=? AND key>? AND (expiresAt IS NULL OR expiresAt>?) ORDER BY key LIMIT ?`,
        params: [name, at, prefix.length, prefix, options.after ?? "", now(), limit],
      });
      return rows.map(refFrom);
    },

    /**
     * A ticket for the caller to PUT exactly `file` straight into this bucket,
     * staged for `space/key`. The same file always stages at the same key, so
     * repeating a reservation re-issues the same destination.
     */
    uploadTicket(target: Address, file: DirectUploadFile): DirectUploadTicket {
      const reference = stagedReference(target, file);
      return {
        url: formatDirectUpload(reference),
        method: "PUT",
        headers: { "Content-Type": file.contentType, "Content-Length": String(file.size) },
        expiresInSeconds: directUploadSeconds,
      };
    },

    /**
     * The uploaded bytes once they match `file` exactly, or null while nothing
     * is staged. Mismatched bytes are discarded and refused (422), so the
     * caller can upload again. The staged copy stays until `discardUpload()`.
     */
    async takeUpload(target: Address, file: DirectUploadFile): Promise<Uint8Array | null> {
      const { key } = stagedReference(target, file);
      const object = await objects().get(key);
      if (!object) return null;
      const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
      if (bytes.byteLength !== file.size || (await sha256Hex(bytes)) !== file.sha256) {
        await objects().delete(key);
        throw new Response("Uploaded bytes do not match the declared size and sha256; upload again", { status: 422 });
      }
      return bytes;
    },

    /** Removes a staged upload; a failed delete is left to the lifecycle rule. */
    async discardUpload(target: Address, file: DirectUploadFile) {
      await objects().delete(stagedReference(target, file).key);
    },

    /** Removes the row, then the bytes; a failed byte delete is left to the lifecycle rule. */
    async delete(target: Address) {
      const { space: at, key } = address(target);
      await db().batch([
        { sql: "DELETE FROM app_storage_objects WHERE bucket=? AND space=? AND key=?", params: [name, at, key] },
      ]);
      await objects().delete(`${at}/${key}`);
    },
  };
}
export type Files = ReturnType<typeof storage>;

type RouteContext = { request: Request; locals: StorageLocals };

/** `/files/:bucket/:space/:key` of a declared space, or null. */
function fileAddress(manifest: StorageManifest, pathname: string) {
  const [prefix, bucket, space, ...rest] = pathname.split("/").slice(1);
  let key: string;
  try {
    key = rest.map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
  if (prefix !== "files" || !Object.hasOwn(manifest.buckets, bucket) ||
      !Object.hasOwn(manifest.buckets[bucket].spaces, space) || !objectKey.safeParse(key).success)
    return null;
  return { bucket, space, key };
}

/**
 * A file the request may read, or null. HEAD reads only the row. Anonymous
 * callers cannot tell a private file from a missing one.
 */
async function readable(locals: StorageLocals, target: Address & { bucket: string }, head: boolean) {
  const files = storage(locals, target.bucket);
  const file = head ? await files.head(target) : await files.get(target);
  const body = file && "body" in file ? (file.body as ReadableStream) : null;
  if (file && (file.visibility === "public" || host(locals).identity)) return { ...file, body };
  await body?.cancel();
  return null;
}

/**
 * `GET /files/:bucket/:space/:key`. Public files answer anyone; organization
 * files need the member identity the platform forwards, and are 404 without it. Mount it at
 * `src/pages/files/[...path].ts` as `export const GET = storageRoutes();`.
 */
export function storageRoutes() {
  return async ({ request, locals }: RouteContext) => {
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const storageHost = host(locals);
    const target = fileAddress(storageHost.manifest, new URL(request.url).pathname);
    const file = target && (await readable(locals, target, request.method === "HEAD"));
    if (!file) return new Response("Not found", { status: 404 });
    // The body's own length is served, never the row's.
    return new Response(file.body, {
      headers: {
        "Content-Type": file.contentType,
        ETag: `"${file.sha256}"`,
        // Stored bytes never run as a page on the app's origin.
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": file.visibility === "public" ? "public, max-age=300" : "private, no-store",
      },
    });
  };
}

/** The identity the platform's daily maintenance call carries. */
export const maintenanceIdentity = { userId: "outfitter:maintenance", role: "system" } as const;

/** One batch of a bucket's expired objects: rows first, then bytes no live row uses. */
async function sweepBatch(storageHost: StorageHost, bucket: string, now: number, batch: number) {
  const database = storageHost.database();
  const expired = await database.query({
    sql: "SELECT id, space, key FROM app_storage_objects WHERE bucket=? AND expiresAt IS NOT NULL AND expiresAt<=? ORDER BY expiresAt LIMIT ?",
    params: [bucket, now, batch],
  });
  if (!expired.length) return 0;
  await database.batch(
    expired.map((row) => ({ sql: "DELETE FROM app_storage_objects WHERE id=? AND expiresAt<=?", params: [row.id, now] })),
  );
  // A put that reused a key and already wrote its row keeps its new bytes.
  // (One whose row is not yet written can still lose them; it rewrites them
  // on its next put.) D1 binds at most 100 parameters, so check in chunks.
  const live = new Set<string>();
  for (let index = 0; index < expired.length; index += 40) {
    const chunk = expired.slice(index, index + 40);
    for (const row of await database.query({
      sql: `SELECT space, key FROM app_storage_objects WHERE bucket=? AND (${chunk.map(() => "(space=? AND key=?)").join(" OR ")})`,
      params: [bucket, ...chunk.flatMap((row) => [row.space, row.key])],
    }))
      live.add(`${row.space}/${row.key}`);
  }
  const paths = expired.map((row) => `${row.space}/${row.key}`).filter((path) => !live.has(path));
  // Bytes whose delete fails after their row is gone are left to the lifecycle ceiling.
  if (paths.length) await bound(storageHost, bucket).delete(paths);
  return expired.length;
}

/** Deletes expired objects and their rows, in batches; returns how many it removed. */
export async function sweepStorage(storageHost: StorageHost, batch = 500, rounds = 20) {
  const now = storageHost.now?.() ?? Date.now();
  let removed = 0;
  for (const bucket of Object.keys(storageHost.manifest.buckets)) {
    bound(storageHost, bucket);
    for (let round = 0; round < rounds; round++) {
      const swept = await sweepBatch(storageHost, bucket, now, batch);
      removed += swept;
      if (swept < batch) break;
    }
  }
  return removed;
}

/**
 * `POST /api/maintenance`, which the platform calls daily for each operational
 * installation; apps need no cron triggers of their own.
 */
export function storageMaintenance() {
  return async ({ request, locals }: RouteContext) => {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    const caller = requestIdentity(request);
    if (caller.userId !== maintenanceIdentity.userId || caller.role !== maintenanceIdentity.role)
      return new Response("Forbidden", { status: 403 });
    return Response.json({ removed: await sweepStorage(host(locals)) });
  };
}

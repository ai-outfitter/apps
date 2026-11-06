import { env } from "cloudflare:workers";
import { type AppIdentity, requestIdentity } from "../server";
import {
  type StorageHost,
  type StorageManifest,
  type StorageObjects,
  storageBinding,
} from "../storage";
import { agentDatabase } from "./database";

const bindings = () => env as unknown as Record<string, StorageObjects | undefined>;

/** `locals.storage` for one request: this installation's bound buckets and database. */
export function cloudflareStorage(manifest: StorageManifest, request: Request): StorageHost {
  let identity: AppIdentity | null = null;
  try {
    identity = requestIdentity(request);
  } catch {
    // Anonymous: public files only.
  }
  return {
    manifest,
    database: agentDatabase,
    objects: (bucket) => (Object.hasOwn(manifest.buckets, bucket) ? bindings()[storageBinding(bucket)] : undefined),
    identity,
  };
}

/** `ok` when every declared bucket is bound, else `missing`. */
export function storageHealth(manifest: StorageManifest) {
  return Object.keys(manifest.buckets).every((bucket) => bindings()[storageBinding(bucket)]) ? "ok" : "missing";
}

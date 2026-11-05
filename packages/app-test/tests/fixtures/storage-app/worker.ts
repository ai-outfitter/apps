// A minimal storage app: its manifest stanza, storage() for its own API, and
// the SDK's file and maintenance routes. Bundled by the test, run by the host.
import { cloudflareStorage, storageHealth } from "@ai-outfitter/app-sdk/cloudflare/storage";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import {
  type StorageLocals,
  type Visibility,
  storage,
  storageMaintenance,
  storageManifest,
  storageRoutes,
} from "@ai-outfitter/app-sdk/storage";
import app from "./app.json";

const manifest = storageManifest.parse(app.storage);
const files = storageRoutes();
const maintenance = storageMaintenance();

async function api(request: Request, locals: StorageLocals) {
  requestIdentity(request);
  const url = new URL(request.url);
  const param = (name: string) => url.searchParams.get(name) ?? "";
  const bucket = storage(locals, param("bucket") || undefined);
  const target = { space: param("space"), key: param("key") };
  if (request.method === "PUT") {
    const ref = await bucket.put(target.space, target.key, await request.arrayBuffer(), {
      contentType: request.headers.get("Content-Type") ?? "application/octet-stream",
      ...(url.searchParams.has("ttl") ? { ttl: param("ttl") === "none" ? null : param("ttl") } : {}),
    });
    return { ref, url: bucket.url(ref) };
  }
  if (request.method === "PATCH") return bucket.setVisibility(target, param("visibility") as Visibility);
  if (request.method === "DELETE") return bucket.delete(target);
  if (url.pathname === "/api/files/list") return bucket.list(target.space, { prefix: param("prefix") });
  const file = await bucket.get(target);
  return file ? new Response(file.body, { headers: { "Content-Type": file.contentType } }) : new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request) {
    const { pathname } = new URL(request.url);
    const host = cloudflareStorage(manifest, request);
    // Fixture-only fake clock; the SDK host accepts any `now`.
    const now = request.headers.get("x-fixture-now");
    const locals: StorageLocals = { storage: now ? { ...host, now: () => Number(now) } : host };
    if (pathname === "/__health") {
      const storage = storageHealth(manifest);
      return Response.json({ app: "storage-fixture", status: storage === "ok" ? "ok" : "storage-missing", storage });
    }
    if (pathname.startsWith("/files/")) return files({ request, locals });
    if (pathname === "/api/maintenance") return respond(() => maintenance({ request, locals }));
    if (pathname.startsWith("/api/files")) return respond(() => api(request, locals));
    return new Response("Not found", { status: 404 });
  },
};

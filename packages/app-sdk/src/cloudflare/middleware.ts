import { defineMiddleware } from "astro:middleware";
import { requestIdentity } from "../server";
import { type StorageManifest, storageManifest } from "../storage";
import { databaseHealth } from "./database";
import { cloudflareStorage, storageHealth } from "./storage";

// A Worker missing a declared bucket is not healthy, so every platform
// health check (install, upgrade) refuses it without a storage flag.
async function health(app: string, storage?: StorageManifest) {
  const buckets = storage && storageHealth(storage);
  return Response.json({
    app,
    status: buckets === "missing" ? "storage-missing" : "ok",
    database: await databaseHealth(),
    ...(buckets ? { storage: buckets } : {}),
  });
}

/**
 * Middleware for an app that serves its own `/api/*` from its installation
 * database. Pages stay GET/HEAD; every API request must carry the identity the
 * platform forwards after authenticating the member. `contentSecurityPolicy`
 * applies to built responses that carry no policy of their own; the dev server
 * sends none.
 */
export function dataAppMiddleware(
  app: string,
  contentSecurityPolicy: string,
  // The `storage` stanza of the app's own app.json (docs/app-storage.md).
  options: { storage?: StorageManifest } = {},
) {
  const storage = options.storage && storageManifest.parse(options.storage);
  return defineMiddleware(async ({ request, locals }, next) => {
    const { pathname } = new URL(request.url);
    const api = pathname.startsWith("/api/");
    if (!api && !["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    let response: Response;
    Object.assign(locals, storage && { storage: cloudflareStorage(storage, request) });
    try {
      if (api) requestIdentity(request);
      response = pathname === "/__health" ? await health(app, storage) : await next();
    } catch (error) {
      if (!(error instanceof Response)) throw error;
      response = error;
    }
    response.headers.set("Cache-Control", "private, no-store");
    // `astro dev` injects inline styles and scripts, and Astro applies its own
    // `security.csp` only to builds, so dev pages go without a policy.
    if (!import.meta.env.DEV && !response.headers.has("Content-Security-Policy"))
      response.headers.set("Content-Security-Policy", contentSecurityPolicy);
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  });
}

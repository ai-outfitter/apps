import { defineMiddleware } from "astro:middleware";
import { requestIdentity } from "../server";
import { type StorageManifest, storageManifest } from "../storage";
import { databaseHealth } from "./database";
import { cloudflareStorage, storageHealth } from "./storage";

export type AppMiddlewareOptions = {
  /** The name `/__health` answers with; the platform's install check requires it. */
  app: string;
  /** Sent on built responses that carry no policy of their own; the dev server sends none. */
  contentSecurityPolicy: string;
  /** The `storage` stanza of the app's own app.json (docs/app-storage.md). */
  storage?: StorageManifest;
  /** Fixture pages only: no `/api/*` identity, no database in health, every write 405. */
  readOnly?: boolean;
  /** Served by `astro dev`, which injects inline styles and scripts: no policy is sent.
   * `outfitterApp()` sets it from the Astro command, never from NODE_ENV, so a build
   * made with NODE_ENV=development or test still sends its policy. */
  dev?: boolean;
};

// A Worker missing a declared bucket is not healthy, so every platform
// health check (install, upgrade) refuses it without a storage flag.
async function health(app: string, storage?: StorageManifest, readOnly?: boolean) {
  if (readOnly) return Response.json({ app, status: "ok" });
  const buckets = storage && storageHealth(storage);
  return Response.json({
    app,
    status: buckets === "missing" ? "storage-missing" : "ok",
    database: await databaseHealth(),
    ...(buckets ? { storage: buckets } : {}),
  });
}

/**
 * Middleware for an Outfitter app, registered by the `outfitterApp()` Astro
 * integration (`@ai-outfitter/app-sdk/astro`). Pages stay GET/HEAD; unless the
 * app is read-only, `/api/*` is served from its installation database and every
 * API request must carry the identity the platform forwards after
 * authenticating the member.
 */
export function appMiddleware({ app, contentSecurityPolicy, readOnly, dev, storage: declared }: AppMiddlewareOptions) {
  const storage = declared && storageManifest.parse(declared);
  return defineMiddleware(async ({ request, locals }, next) => {
    const { pathname } = new URL(request.url);
    const api = !readOnly && pathname.startsWith("/api/");
    if (!api && !["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    let response: Response;
    Object.assign(locals, storage && { storage: cloudflareStorage(storage, request) });
    try {
      if (api) requestIdentity(request);
      response = pathname === "/__health" ? await health(app, storage, readOnly) : await next();
    } catch (error) {
      if (!(error instanceof Response)) throw error;
      response = error;
    }
    response.headers.set("Cache-Control", "private, no-store");
    // Astro applies its own `security.csp` only to builds, so dev pages go without a policy.
    if (!dev && !response.headers.has("Content-Security-Policy"))
      response.headers.set("Content-Security-Policy", contentSecurityPolicy);
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  });
}

/** `appMiddleware` for an app that serves its own `/api/*`; prefer `outfitterApp()`. */
export function dataAppMiddleware(
  app: string,
  contentSecurityPolicy: string,
  options: { storage?: StorageManifest } = {},
) {
  return appMiddleware({ app, contentSecurityPolicy, ...options });
}

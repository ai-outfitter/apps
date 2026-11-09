import { defineMiddleware } from "astro:middleware";
import { dataAppMiddleware } from "@ai-outfitter/app-sdk/cloudflare/middleware";

// Pages carry Astro's hashed CSP (astro.config.mjs); this one covers the rest. A demo
// package connects and submits nowhere; the operational app only to itself.
const policy = (reach: "'none'" | "'self'") => `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' blob:; connect-src ${reach}; base-uri 'none'; frame-ancestors 'none'; form-action ${reach}`;
const fallbackPolicy = policy("'none'");

const demoMiddleware = defineMiddleware(async ({ request }, next) => {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const response = new URL(request.url).pathname === "/__health"
    ? Response.json({ app: "forerunner", status: "ok" })
    : await next();
  response.headers.set("Cache-Control", "private, no-store");
  if (!response.headers.has("Content-Security-Policy")) response.headers.set("Content-Security-Policy", fallbackPolicy);
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
});

export const onRequest = import.meta.env.OUTFITTER_APP_MODE === "demo" ? demoMiddleware : dataAppMiddleware("forerunner", policy("'self'"));

import { defineMiddleware } from "astro:middleware";
export const onRequest = defineMiddleware(async ({ request }, next) => {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  const response =
    new URL(request.url).pathname === "/__health"
      ? Response.json({ app: "hr", status: "ok" })
      : await next();
  response.headers.set("Cache-Control", "private, no-store");
  // `astro dev` injects inline styles and scripts; builds emit them as files.
  if (!import.meta.env.DEV)
    response.headers.set(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
});

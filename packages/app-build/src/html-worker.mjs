// Build prepends the template's literal HTML and slug. The platform owns auth;
// this dispatch-only Worker has no sessions, secrets or identity API.
export function htmlWorker(html, app) {
return {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    if (path.startsWith("/_astro/")) return env.ASSETS.fetch(request);
    let body, type;
    if (path === "/__health") {
      body = JSON.stringify({ app, status: "ok" });
      type = "application/json";
    } else if (["/", "/settings", "/settings/"].includes(path)) {
      body = html;
      type = "text/html; charset=utf-8";
    } else return new Response(null, { status: 404, headers });
    return new Response(request.method === "HEAD" ? null : body, {
      headers: { ...headers, "Content-Type": type,
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" },
    });
  },
};
}

async function requireAdmin(platform, request, env, context) {
  const url = new URL(request.url);
  const access = await platform.fetch(new Request(new URL("/api/admin", url), {
    headers: request.headers,
  }), env, context);
  await access.body?.cancel();
  if (url.pathname === "/api/whoami" && access.status !== 200)
    return new Response(access.status === 401 ? "Unauthorized" : access.status === 403 ? "Forbidden" : "Identity check unavailable", {
      status: access.status >= 400 ? access.status : 502,
      headers: { "Cache-Control": "private, no-store" },
    });
  if (access.status === 401) {
    const login = new URL("/login", url);
    login.searchParams.set("returnTo", url.href);
    return Response.redirect(login, 302);
  }
  if (access.status !== 200)
    return new Response("Platform administrator required", { status: 403 });
}

function publicRoute(url, publicAssets) {
  return ["/login", "/logout"].includes(url.pathname.replace(/\/$/, "")) ||
    url.pathname.startsWith("/api/auth/") || publicAssets.has(url.pathname);
}

async function templateResponse(app, request, env, context) {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  const response = await app.fetch(new Request(request, { headers }), { ASSETS: env.ASSETS }, context);
  const result = new Response(response.body, response);
  result.headers.delete("Set-Cookie");
  result.headers.set("Cache-Control", "private, no-store");
  return result;
}

/** One template and platform in the existing Worker Preview. An app's preview
 * policy (`app.json` `preview.policy`) may make an operational bundle switchable
 * to its fixtures; a host-only mode cookie then gates the platform paths it names. */
export function appPreview(platform, app, template, revision, platformAssets, platformOrigin, policy) {
  const publicAssets = new Set(platformAssets);
  // A switchable preview's mode switch, or a platform path in operational mode.
  async function switched(url, request, env, context) {
    if (url.pathname === "/__preview/mode") return policy.switch(request);
    if (policy.platformPath(url.pathname, request.method) && await policy.select(request, platform, env, context) === "operational")
      return platform.fetch(request, env, context);
  }
  async function authorized(request, env, context) {
    const url = new URL(request.url);
    const switchable = Boolean(policy) && env.PREVIEW_INTERNAL === "true";
    const forwarded = switchable && await switched(url, request, env, context);
    if (forwarded) return forwarded;
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Read-only demo", { status: 405 });
    if (url.pathname === "/api/whoami" && request.method === "GET")
      return platform.fetch(request, env, context);
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    const response = await templateResponse(app, request, env, context);
    if (!policy) return response;
    // Fixtures unless a switchable preview selects the operational platform.
    return policy.decorate(response, switchable ? await policy.select(request, platform, env, context) : "demo", platformOrigin);
  }
  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      if (url.pathname === "/api/health") return Response.json({ status: "ok", app: template, mode: "demo", revision });
      if (publicRoute(url, publicAssets)) return platform.fetch(request, env, context);
      const denial = await requireAdmin(platform, request, env, context);
      return denial || authorized(request, env, context);
    },
  };
}

const COOKIE = "outfitter-preview-mode";
export async function previewMode(request, platform, env, context) {
  const selection = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (["demo", "operational"].includes(selection)) return selection;
  try {
    const response = await platform.fetch(
      new Request(new URL("/api/plugins/github", request.url), {
        headers: request.headers,
      }),
      env,
      context,
    );
    if (!response.ok) {
      await response.body?.cancel();
      return "demo";
    }
    const plugin = await response.json();
    const approved = new Set(
      (plugin.scopes || []).flatMap((scope) => scope.repositories || []),
    );
    const available =
      plugin.connected &&
      plugin.repositoryAccess &&
      (plugin.repositories || []).some(
        (repo) =>
          approved.has(repo.name) &&
          plugin.readiness?.[repo.name]?.status === "ready",
      );
    return available ? "operational" : "demo";
  } catch {
    return "demo";
  }
}

export async function switchPreviewMode(request) {
  const url = new URL(request.url);
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (request.headers.get("origin") !== url.origin)
    return new Response("Invalid origin", { status: 403 });
  const mode = (await request.formData()).get("mode");
  if (!["demo", "operational"].includes(mode))
    return new Response("Invalid mode", { status: 400 });
  const previous = new URL(request.headers.get("referer") || "/", url);
  const destination =
    previous.origin === url.origin &&
    !previous.pathname.startsWith("/__preview/")
      ? previous.pathname + previous.search
      : "/";
  return new Response(null, {
    status: 303,
    headers: {
      Location: destination,
      "Set-Cookie": `${COOKIE}=${mode}; Path=/; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`,
      "Cache-Control": "private, no-store",
    },
  });
}

// Platform reads only. The app's own routes (bootstrap, issues, milestones) run
// on the workflow host, which a preview does not bind; those pages fall back to
// their empty and error states in GitHub mode.
export function platformPath(path, method) {
  if (["GET", "HEAD"].includes(method))
    return (
      [
        "/api/plugins/github",
        "/api/plugins/github/governance",
        "/api/platform/features/resident-identities",
        "/api/workflow-runs",
        "/workflow-runs",
        "/plugins/github",
      ].includes(path) ||
      /^\/workflow-runs\/[a-zA-Z0-9-]+$/.test(path) ||
      /^\/api\/workflow-runs\/[a-zA-Z0-9-]+$/.test(path) ||
      /^\/c\/[a-zA-Z0-9-]+$/.test(path) ||
      /^\/api\/chats\/[a-zA-Z0-9-]+$/.test(path) ||
      /^\/api\/workspaces\/[a-zA-Z0-9-]+(?:\/(?:files|download))?$/.test(path)
    );
  return (
    (["/api/workflow-runs", "/plugins/github"].includes(path) &&
      method === "POST") ||
    (path === "/api/plugins/github" && method === "PUT") ||
    (path === "/api/organizations/github" && ["PUT", "DELETE"].includes(method))
  );
}

export async function withPreviewControls(response, mode, platformOrigin) {
  if (!response.headers.get("content-type")?.includes("text/html"))
    return response;
  const html = await response.text();
  const originMeta = platformOrigin
    ? `<meta name="outfitter-platform-origin" content="${new URL(platformOrigin).origin}">`
    : "";
  const controls = `<form method="post" action="/__preview/mode" aria-label="Preview data" class="outfitter-preview-controls"><strong>Preview data</strong><button name="mode" value="demo" ${mode === "demo" ? "disabled" : ""}>Demo</button><button name="mode" value="operational" ${mode === "operational" ? "disabled" : ""}>GitHub</button></form>`;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("etag");
  headers.delete("set-cookie");
  headers.set("Cache-Control", "private, no-store");
  return new Response(
    html
      .replace(
        "<head>",
        `<head>${originMeta}<meta name="outfitter-preview-mode" content="${mode}">`,
      )
      .replace("</body>", `${controls}</body>`),
    { status: response.status, headers },
  );
}

/** Software Foundry's preview policy for `@ai-outfitter/server/preview`, named by `app.json` `preview.policy`. */
export const previewPolicy = {
  select: previewMode,
  switch: switchPreviewMode,
  platformPath,
  decorate: withPreviewControls,
};

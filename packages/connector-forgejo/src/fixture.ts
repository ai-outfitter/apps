import type { ForgejoTransport } from "./adapter";

export function forgejoFixtureTransport(
  options: { onRequest?: (request: Request) => Promise<void> | void } = {},
): ForgejoTransport {
  return async (request) => {
    await options.onRequest?.(request);
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/user")
      return Response.json({
        id: 42,
        login: "fixture-resident",
        avatar_url: "https://untrusted.invalid/avatar",
      });
    const match = url.pathname.match(
      /^\/api\/v1\/repos\/([^/]+)\/([^/]+)(?:\/(issues|pulls))?$/,
    );
    if (!match) return Response.json({ message: "not found" }, { status: 404 });
    const [, owner, repo, resource] = match;
    if (!resource)
      return Response.json({
        id: 7,
        name: repo,
        full_name: `${owner}/${repo}`,
        description: "Fixture repository",
        default_branch: "main",
        private: true,
        archived: false,
        html_url: "https://untrusted.invalid/repository",
      });
    return Response.json([
      {
        number: 12,
        title: resource === "issues" ? "Fixture issue" : "Fixture pull request",
        state: "open",
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-02T00:00:00Z",
        html_url: "https://untrusted.invalid/item",
      },
    ]);
  };
}

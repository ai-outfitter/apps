import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import { sidebarContext, sidebarThreadId } from "@ai-outfitter/app-sdk/threads";

/** A display contract sent only by authenticated platform page dispatch. */
export async function platformSidebar(request: Request) {
  const endpoint = request.headers.get("x-outfitter-sidebar-base");
  if (!endpoint) return null;
  let url: URL;
  try { url = new URL(endpoint); } catch { return null; }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !/^\/(?:o\/[a-z0-9-]+\/)?api\/platform\/threads$/.test(url.pathname)) return null;
  const identity = requestIdentity(request);
  // Cross-organization app grants are not membership in its platform sidebar.
  if (identity.role === "external") return null;
  const owner = { userId: identity.userId, organizationId: identity.organizationId ?? null };
  return { userId: identity.userId, scopeKey: owner.organizationId ?? "personal", endpoint,
    thread: { id: await sidebarThreadId(owner), context: sidebarContext(owner) } };
}

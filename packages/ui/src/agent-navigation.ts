import { navigatePart, navigatePartName } from "@ai-outfitter/app-sdk/agent-page";

/** The page's path and query relative to the app's root, which `navigate_page` paths use too. */
export function appLocation(prefix: string, url: Pick<Location, "pathname" | "search"> = location) {
  return (url.pathname.slice(prefix.length) + url.search).replace(/^\/+/, "");
}
/**
 * The app's mount prefix on the main host (`/o/<org>/<app>` or a personal
 * `/apps/<id>`), empty on an app's own host. Platform paths that the service
 * returns (`/api/platform/...`) and the app's own routes are resolved under
 * it, so a canonical organization page never reads through the root personal
 * owner, and a path app's CSP never blocks them.
 */
export function mountPrefix(pathname: string) {
  return /^\/o\/[^/]+\/[^/]+/.exec(pathname)?.[0] ?? /^\/apps\/[^/]+/.exec(pathname)?.[0] ?? "";
}
/** Scope an app-local API endpoint to the installation, without rebasing an existing mount twice. */
export function appEndpoint(prefix: string, endpoint: string) {
  if (!prefix || !endpoint.startsWith("/") || endpoint.startsWith("//") || endpoint === prefix || endpoint.startsWith(`${prefix}/`)) return endpoint;
  return prefix + endpoint;
}
/** The page a reply asked to open: its last navigation part. */
export function requestedPage(entries: readonly { submissionId?: string | null; status?: string; parts: readonly { type: string }[] }[], submissionId: string) {
  let found: { location: string; label: string } | undefined;
  for (const entry of entries) {
    // A stopped or failed attempt of the same submission never navigates.
    if (entry.submissionId !== submissionId || (entry.status && entry.status !== "complete")) continue;
    for (const part of entry.parts) {
      const parsed = part.type === "data" && (part as { name?: string }).name === navigatePartName ? navigatePart.safeParse((part as { data?: unknown }).data) : null;
      if (parsed?.success) found = parsed.data;
    }
  }
  return found;
}
/** The page's address, or null when it would resolve outside the app's mount. */
export function pageHref(prefix: string, appLocation: string, base: string) {
  const url = new URL(`${prefix}/${appLocation}`, base);
  return url.origin === new URL(base).origin && url.pathname.startsWith(`${prefix}/`) ? url.pathname + url.search : null;
}
/** Follows a link, so Astro's client router (when the page has one) swaps the page in place. */
export function openPage(href: string) {
  const link = document.createElement("a");
  link.href = href;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

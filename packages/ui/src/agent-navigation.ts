import { navigatePart, navigatePartName } from "@ai-outfitter/app-sdk/agent-page";

/** The page's path and query relative to the app's root, which `navigate_page` paths use too. */
export function appLocation(prefix: string, url: Pick<Location, "pathname" | "search"> = location) {
  return (url.pathname.slice(prefix.length) + url.search).replace(/^\/+/, "");
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

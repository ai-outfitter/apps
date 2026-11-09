import { onPageLoad } from "@ai-outfitter/ui/page";

export type WikiContext = {
  installationId: string;
  hostname: string | null;
  slug: string;
  writable: boolean;
};
let pending: Promise<WikiContext> | undefined;
export function planningWikiContext() {
  if (import.meta.env.OUTFITTER_APP_MODE === "demo")
    return Promise.reject(new Error("Wiki is unavailable in the read-only demo"));
  pending ??= fetch("/api/apps/planning/use-cases/context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).then(async (response) => {
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<WikiContext>;
  });
  return pending;
}
export function wikiHref(wiki: WikiContext, path = "") {
  const url = new URL(location.origin);
  const mounted = /^\/o\/([^/]+)\//.exec(location.pathname);
  if (mounted && wiki.hostname) {
    url.pathname = `/o/${mounted[1]}/${encodeURIComponent(wiki.slug)}/${path}`;
    return url.href;
  }
  if (wiki.hostname) url.hostname = wiki.hostname;
  url.pathname = `${wiki.hostname ? "/" : `/apps/${encodeURIComponent(wiki.slug)}/`}${path}`;
  return url.href;
}
onPageLoad(() => {
  const link = document.getElementById("planning-wiki-link") as HTMLAnchorElement | null;
  if (!link) return;
  link.hidden = true;
  if (import.meta.env.OUTFITTER_APP_MODE !== "demo")
    void planningWikiContext()
      .then((wiki) => {
        link.href = wikiHref(wiki);
        link.hidden = false;
      })
      .catch(() => {
        link.hidden = true;
      });
});

/** Server counterpart of the browser Wiki navigation helper. */
export function wikiPageHref(
  wiki: { slug: string; hostname: string | null },
  url: URL,
  path = "",
) {
  const mounted = /^\/o\/([^/]+)\//.exec(url.pathname);
  if (mounted) return `/o/${mounted[1]}/${encodeURIComponent(wiki.slug)}/${path}`;
  if (wiki.hostname) {
    const target = new URL(url.origin);
    target.hostname = wiki.hostname;
    target.pathname = `/${path}`;
    return target.href;
  }
  return `/apps/${encodeURIComponent(wiki.slug)}/${path}`;
}

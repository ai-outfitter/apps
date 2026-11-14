/**
 * A root-relative app path (`/products`) as a link relative to the page at
 * `pathname`, the path the app sees. Planning runs at its host's root, under
 * /o/<org>/planning/ and under a person's /apps/<slug>/; only the last serves
 * root-relative links unchanged, so they would leave the app there. Relative
 * links stay inside every mount. Other URLs, and platform paths such as another
 * app's /apps/<slug>/ or /o/<org>/ address, pass through.
 */
export function appHref(pathname: string, target: string) {
  if (!target.startsWith("/") || target.startsWith("//") || /^\/(?:o|apps)(?:[/?#]|$)/.test(target)) return target;
  const depth = pathname.split("/").filter(Boolean).length - (pathname.endsWith("/") ? 0 : 1);
  return ("../".repeat(Math.max(0, depth)) || "./") + target.slice(1);
}

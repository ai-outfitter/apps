/**
 * Where this app is mounted, with no trailing slash: "" on its own host,
 * "/o/<org>/forerunner" on an organization mount, "/apps/<id>" for a
 * personal install. `depth` is how many path segments the current page
 * sits below the app root (0 for the home page, 1 for "/life", 2 for
 * "/runs/<id>"). API calls and navigations are built on it so they stay
 * inside the app wherever it is served.
 */
export function appMount(depth: number) {
  const segments = location.pathname.split("/").filter(Boolean);
  const kept = segments.slice(0, Math.max(0, segments.length - depth));
  return kept.length ? `/${kept.join("/")}` : "";
}

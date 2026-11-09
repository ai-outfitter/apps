/**
 * Where the Wiki that holds a run's records is served, by its slug: the organization's
 * Wiki beside an organization mount, else the member's own personal Wiki
 * under /apps/<slug>/.
 */
export function wikiBase(wikiSlug: string) {
  const org = location.pathname.match(/^\/o\/([^/]+)\//);
  return org ? `/o/${org[1]}/${wikiSlug}` : `/apps/${wikiSlug}`;
}

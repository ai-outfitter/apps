// Keeps a persisted app sidebar in step with client-side navigation.

const sidebar = (root: Document) => root.getElementById("sidebar");
const navs = (root: Element) => [...root.querySelectorAll<HTMLElement>("nav.ui-navigation[aria-label]")];
const label = (nav: Element) => nav.getAttribute("aria-label") ?? "";

/**
 * Makes links absolute against `base`, since a persisted sidebar outlives the
 * page its relative links were written for. "#" marks a link a script fills
 * in, so it keeps the value that script set.
 */
function absolute(links: Iterable<Element>, base: string | URL) {
  for (const link of links) {
    const href = link.getAttribute("href");
    if (href && href !== "#") link.setAttribute("href", new URL(href, base).href);
  }
}

const signature = (nav: Element) => [...nav.querySelectorAll("a")].map((link) => `${link.id}\n${link.textContent}`).join("\n\n");

/** Updates each navigation list from the next page: its links, current page and visibility. */
function syncNavigation(current: HTMLElement, next: HTMLElement, to: URL) {
  const nextNavs = navs(next);
  for (const nav of navs(current)) {
    const nextNav = nextNavs.find((candidate) => label(candidate) === label(nav));
    if (!nextNav) {
      nav.remove();
      continue;
    }
    const links = nav.querySelectorAll("a"), nextLinks = nextNav.querySelectorAll("a");
    absolute(nextLinks, to);
    // Different links: take the next page's list. The same links: keep them,
    // with any state a script gave them, and update what the page decides.
    if (signature(nav) !== signature(nextNav)) {
      nav.replaceWith(document.importNode(nextNav, true));
      continue;
    }
    links.forEach((link, index) => {
      const nextLink = nextLinks[index];
      const currentPage = nextLink.getAttribute("aria-current");
      if (currentPage) link.setAttribute("aria-current", currentPage);
      else link.removeAttribute("aria-current");
      // A script owns a "#" link's address and visibility.
      const href = nextLink.getAttribute("href");
      if (href === "#") return;
      if (href) link.setAttribute("href", href);
      link.hidden = nextLink.hidden;
    });
  }
  // A list only the next page has goes after the list before it there.
  for (const nextNav of nextNavs) {
    if (navs(current).some((nav) => label(nav) === label(nextNav))) continue;
    absolute(nextNav.querySelectorAll("a"), to);
    const imported = document.importNode(nextNav, true);
    const previous = nextNavs.slice(0, nextNavs.indexOf(nextNav)).reverse()
      .map((candidate) => navs(current).find((nav) => label(nav) === label(candidate)))
      .find(Boolean);
    const first = navs(current)[0];
    // insertBefore, since the platform's Worker types redefine after() and before().
    if (previous) previous.parentNode?.insertBefore(imported, previous.nextSibling);
    else if (first) first.parentNode?.insertBefore(imported, first);
    else current.appendChild(imported);
  }
}

export function installAppNavigation() {
  const state = window as Window & { __outfitterAppNavigation?: boolean };
  if (state.__outfitterAppNavigation) return;
  state.__outfitterAppNavigation = true;
  document.addEventListener("astro:before-swap", (event) => {
    const { newDocument, to } = event as Event & { newDocument: Document; to: URL };
    const current = sidebar(document), next = sidebar(newDocument);
    const key = current?.dataset.astroTransitionPersist;
    if (current && next && key && key === next.dataset.astroTransitionPersist) syncNavigation(current, next, to);
  });
  const absoluteLinks = () => absolute(sidebar(document)?.querySelectorAll("a[href]") ?? [], location.href);
  document.addEventListener("astro:page-load", absoluteLinks);
  absoluteLinks();
}

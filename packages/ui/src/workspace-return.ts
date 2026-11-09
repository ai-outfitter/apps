import { iconPaths } from "./icons";
import { railNavigation, type RailOrganization } from "./rail-navigation";

// The one way back from an opened app to Outfitter (docs/decisions/app-owns-its-shell.md).
// Framed, the link posts a fixed message; the parent picks the destination.

/** Meta tag the platform adds to served app pages: the main site's Apps URL. */
export const WORKSPACE_APPS_META = "outfitter-apps";
/** The only message an embedded app sends its workspace. */
export const WORKSPACE_RETURN = "outfitter:return";
/** The shared layout's Back to Outfitter link. */
export const WORKSPACE_RETURN_ID = "outfitter-return";

/** True only for the return message from the workspace's own app frame. */
export function isWorkspaceReturn(
  event: Pick<MessageEvent, "source" | "origin" | "data">,
  frame: { contentWindow: unknown; src: string } | null,
) {
  if (!frame || !event.source || event.source !== frame.contentWindow) return false;
  return event.origin === new URL(frame.src).origin && event.data === WORKSPACE_RETURN;
}

function readOrganization(metadata: string | undefined): RailOrganization | undefined {
  if (!metadata) return;
  const parsed: unknown = JSON.parse(metadata);
  if (!parsed || typeof parsed !== "object" || !("name" in parsed) || typeof parsed.name !== "string" || !("href" in parsed) || typeof parsed.href !== "string") throw new Error("Invalid organization navigation");
  return { name: parsed.name, href: parsed.href, current: "current" in parsed && typeof parsed.current === "string" ? parsed.current : undefined };
}

function renderRail(rail: HTMLElement, navigation: ReturnType<typeof railNavigation>, current: string | undefined, footer: HTMLElement | null, platformOrigin: string) {
  const nav = rail.querySelector<HTMLElement>("[data-rail-navigation]");
  const scope = rail.querySelector<HTMLAnchorElement>("[data-rail-scope]");
  const personal = rail.querySelector<HTMLAnchorElement>("[data-rail-personal-return]");
  if (!nav || !scope || !personal) return false;
  const organization = navigation.organization;
      nav.setAttribute("aria-label", navigation.label);
      nav.replaceChildren(...navigation.links.map(item => {
        const anchor = document.createElement("a");
        anchor.href = item.href;
        anchor.dataset.railKey = item.key;
        anchor.setAttribute("aria-label", item.label);
        anchor.title = item.label;
        if ((organization?.current ?? current) === item.key) anchor.setAttribute("aria-current", "page");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        for (const [name, value] of Object.entries({ width: "20", height: "20", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "aria-hidden": "true" })) svg.setAttribute(name, value);
        const path = document.createElementNS(svg.namespaceURI, "path");
        path.setAttribute("d", iconPaths[item.icon]);
        svg.appendChild(path);
        anchor.appendChild(svg);
        return anchor;
      }));
      scope.hidden = !organization;
      scope.removeAttribute("href");
      scope.textContent = organization?.name.slice(0, 1).toUpperCase() ?? "";
      if (organization) { scope.href = organization.href; scope.title = organization.name; scope.setAttribute("aria-label", organization.name); }
      personal.hidden = !navigation.personalHref;
      personal.removeAttribute("href");
      if (navigation.personalHref) personal.href = navigation.personalHref;
      if (footer) {
        footer.dataset.platformOrigin = platformOrigin;
        rail.querySelector("[data-personal-account]")?.appendChild(footer);
      }
      rail.hidden = false;
  return true;
}

/** Shows the app's Back to Outfitter link when the platform named a destination. */
export function installWorkspaceReturn() {
  const link = document.getElementById(WORKSPACE_RETURN_ID);
  const named = document.querySelector<HTMLMetaElement>(`meta[name="${WORKSPACE_APPS_META}"]`)?.content;
  const rail = document.querySelector<HTMLElement>(".personal-rail");
  const footer = document.querySelector<HTMLElement>("[data-account-footer]");
  const sidebar = document.querySelector<HTMLElement>("#sidebar");
  if (footer && sidebar && rail?.contains(footer)) sidebar.appendChild(footer);
  if (rail) {
    rail.hidden = true;
    rail.querySelectorAll<HTMLAnchorElement>("[data-rail-key]").forEach((item) => {
      item.removeAttribute("href");
      item.removeAttribute("aria-current");
    });
  }
  if (!(link instanceof HTMLAnchorElement)) return;
  link.closest("nav")?.setAttribute("hidden", "");
  link.onclick = null;
  if (!named) return;
  // Only explicit platform metadata selects the owner context.
  const current = document.querySelector<HTMLMetaElement>('meta[name="outfitter-personal-navigation"]')?.content;
  const organizationMeta = document.querySelector<HTMLMetaElement>('meta[name="outfitter-organization-navigation"]')?.content;
  try {
    const platform = new URL(named);
    const organization = readOrganization(organizationMeta);
    const navigation = railNavigation(platform.href, organization);
    if (rail && parent === window && (organization || current === "wiki" || current === "app")) {
      if (renderRail(rail, navigation, current, footer, platform.origin)) return;
    }
  } catch { /* Missing or invalid platform metadata leaves the rail hidden. */ }
  link.href = named;
  link.closest("nav")?.removeAttribute("hidden");
  if (parent === window) return;
  // Embedded, this link replaces the app's Organization utility.
  const org = document.getElementById("org");
  if (org) org.hidden = true;
  link.onclick = (event) => {
    event.preventDefault();
    parent.postMessage(WORKSPACE_RETURN, new URL(link.href).origin);
  };
}

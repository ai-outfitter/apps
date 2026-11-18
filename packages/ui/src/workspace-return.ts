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
    rail.querySelectorAll<HTMLAnchorElement>("[data-personal-destination]").forEach((item) => {
      item.removeAttribute("href");
      item.removeAttribute("aria-current");
    });
  }
  if (!(link instanceof HTMLAnchorElement)) return;
  link.closest("nav")?.setAttribute("hidden", "");
  link.onclick = null;
  if (!named) return;
  // The platform explicitly marks personal app pages; legacy app metadata alone
  // never selects a personal context or an active Wiki link.
  const current = document.querySelector<HTMLMetaElement>('meta[name="outfitter-personal-navigation"]')?.content;
  try {
    const platform = new URL(named);
    if (rail && parent === window && (current === "wiki" || current === "app") && ["http:", "https:"].includes(platform.protocol) && !platform.username && !platform.password) {
      rail.querySelectorAll<HTMLAnchorElement>("[data-personal-destination]").forEach((item) => {
        item.href = new URL(item.dataset.personalDestination!, platform.origin).href;
        if (current === item.dataset.personalKey) item.setAttribute("aria-current", "page");
        else item.removeAttribute("aria-current");
      });
      if (footer) {
        footer.dataset.platformOrigin = platform.origin;
        rail.querySelector("[data-personal-account]")?.appendChild(footer);
      }
      rail.hidden = false;
      return;
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

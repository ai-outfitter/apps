// Shared DOM behavior. No app API, tenant state or router ownership.
import { installChatViewport } from "./chat-viewport";
import { installPullRefresh } from "./pull-refresh";

const desktop = () => window.matchMedia("(min-width: 761px)").matches;
const mobile = () => window.matchMedia("(max-width: 760px)").matches;
const sidebar = () => document.getElementById("sidebar");

export const SIDEBAR_CLOSE = "outfitter:sidebar-close";

function isOpen() {
  return Boolean(sidebar()?.classList.contains("open"));
}

/** Mirror the sidebar's state onto the shell, header toggle and dismiss layer. */
function sync() {
  const aside = sidebar();
  if (!aside) return;
  const open = aside.classList.contains("open");
  aside.closest(".app-shell")?.classList.toggle("sidebar-open", open);
  document
    .querySelectorAll<HTMLElement>('[aria-controls="sidebar"]')
    .forEach((toggle) => {
      toggle.setAttribute("aria-expanded", String(open));
      const label = open ? toggle.dataset.closeLabel : toggle.dataset.openLabel;
      if (label) toggle.setAttribute("aria-label", label);
    });
  document
    .querySelectorAll<HTMLElement>(".sidebar-dismiss")
    .forEach((dismiss) => {
      dismiss.hidden = !open;
    });
}

function setOpen(open: boolean) {
  const aside = sidebar();
  if (!aside) return;
  // A closing mobile drawer becomes hidden; keep keyboard focus reachable.
  if (!open && mobile() && aside.contains(document.activeElement))
    document.querySelector<HTMLElement>(".app-shell .menu")?.focus();
  aside.classList.toggle("open", open);
  sync();
}

/** Desktop defaults come from the page; mobile drawers always start closed. */
function applyDefault() {
  const aside = sidebar();
  if (!aside) return;
  aside.classList.toggle(
    "open",
    aside.dataset.desktopOpen === "true" && desktop(),
  );
  aside.dataset.shellReady = "";
  sync();
}

export function closeSidebarOnMobile() {
  if (mobile()) setOpen(false);
}

function canStartSwipe(event: TouchEvent) {
  return Boolean(
    sidebar() &&
    mobile() &&
    event.touches.length === 1 &&
    !document.querySelector("dialog[open]"),
  );
}

function isVerticalSwipe(dx: number, dy: number) {
  return dy > 24 && dy > Math.abs(dx);
}

function completedSwipe(distance: number, dy: number) {
  return distance >= 60 && distance > dy * 1.5;
}

function installSwipe() {
  const installed = () =>
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone;
  if (!installed()) return;
  let start: { x: number; y: number; id: number } | undefined;
  const cancel = () => {
    start = undefined;
  };
  document.addEventListener(
    "touchstart",
    (event) => {
      cancel();
      if (!canStartSwipe(event)) return;
      if (event.target instanceof Element && event.target.closest(".personal-rail a, .personal-rail button")) return;
      const open = isOpen();
      const touch = event.touches[0];
      if (!open && touch.clientX > 24) return;
      // iOS requires cancelling touchstart to claim its history-navigation edge.
      if (!open) {
        if (!event.cancelable) return;
        event.preventDefault();
      }
      start = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
    },
    { passive: false },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (!start) return;
      if (
        event.touches.length !== 1 ||
        event.touches[0].identifier !== start.id
      ) {
        cancel();
        return;
      }
      const open = isOpen();
      const dx = event.touches[0].clientX - start.x;
      const dy = Math.abs(event.touches[0].clientY - start.y);
      if (isVerticalSwipe(dx, dy)) {
        cancel();
        return;
      }
      const distance = open ? -dx : dx;
      if (distance > dy && event.cancelable) event.preventDefault();
      if (completedSwipe(distance, dy)) {
        cancel();
        setOpen(!open);
      }
    },
    { passive: false },
  );
  document.addEventListener("touchend", cancel);
  document.addEventListener("touchcancel", cancel);
}

function toggleDisclosure(disclosure: HTMLElement) {
  const panel = document.getElementById(disclosure.getAttribute("aria-controls") || "");
  const expanded = disclosure.getAttribute("aria-expanded") !== "true";
  disclosure.setAttribute("aria-expanded", String(expanded));
  if (panel) panel.hidden = !expanded;
}

function shouldWrapFocus(shiftKey: boolean, boundary: HTMLElement) {
  return shiftKey &&
    (document.activeElement === boundary || !sidebar()?.contains(document.activeElement));
}

function closeMenusOutside(target: Element | null) {
  for (const toggle of document.querySelectorAll<HTMLElement>('[data-disclosure][aria-expanded="true"][aria-controls="account-menu"], [data-disclosure][aria-expanded="true"][aria-controls="app-tools-menu"]')) {
    const panel = document.getElementById(toggle.getAttribute("aria-controls") || "");
    const inside = target && (toggle.contains(target) || panel?.contains(target));
    const appLink = panel?.id === "app-tools-menu" && target?.closest("a[href]");
    if (!inside || appLink) toggleDisclosure(toggle);
  }
}

function activateDisclosure(disclosure: HTMLElement | null | undefined) {
  if (!disclosure) return;
  toggleDisclosure(disclosure);
  if (disclosure.closest(".personal-rail")) closeSidebarOnMobile();
}

function closeExpandedDisclosure() {
  const expanded = document.querySelector<HTMLElement>('[data-disclosure][aria-expanded="true"]');
  if (!expanded) return false;
  toggleDisclosure(expanded);
  expanded.focus();
  return true;
}

function trapSidebarFocus(event: KeyboardEvent) {
    const focusable = [
      ...(sidebar()?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
      ) || []),
    ].filter((el) => el.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0],
      last = focusable[focusable.length - 1];
    if (shouldWrapFocus(event.shiftKey, first)) {
      event.preventDefault();
      last.focus();
    } else if (shouldWrapFocus(!event.shiftKey, last)) {
      event.preventDefault();
      first.focus();
    }
}

function install() {
  const state = window as Window & { __outfitterUiShell?: boolean };
  if (state.__outfitterUiShell) return;
  state.__outfitterUiShell = true;
  installChatViewport();
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const disclosure = target?.closest<HTMLElement>("[data-disclosure]");
    closeMenusOutside(target);
    if (target?.closest('.menu[aria-controls="sidebar"]')) {
      setOpen(!isOpen());
      if (isOpen() && mobile())
        sidebar()
          ?.querySelector<HTMLElement>("a[href], button:not(:disabled)")
          ?.focus();
      return;
    }
    if (target?.closest(".sidebar-dismiss")) return setOpen(false);
    activateDisclosure(disclosure);
    if (target?.closest("#sidebar a[href]") && !event.defaultPrevented)
      closeSidebarOnMobile();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && closeExpandedDisclosure()) { event.preventDefault(); return; }
    if (!isOpen() || !mobile() || document.querySelector("dialog[open]"))
      return;
    if (event.key === "Escape") {
      setOpen(false);
      document.querySelector<HTMLElement>(".app-shell .menu")?.focus();
    }
    if (event.key !== "Tab") return;
    trapSidebarFocus(event);
  });
  document.addEventListener(SIDEBAR_CLOSE, closeSidebarOnMobile);
  document.addEventListener("astro:before-preparation", closeSidebarOnMobile);
  document.addEventListener("astro:after-swap", () => {
    const aside = sidebar();
    if (aside && !("shellReady" in aside.dataset)) applyDefault();
    else sync();
  });
  window
    .matchMedia("(min-width: 761px)")
    .addEventListener("change", applyDefault);
  installSwipe();
  installPullRefresh();
}
install();
const aside = sidebar();
if (aside && !("shellReady" in aside.dataset)) applyDefault();
else sync();

// Pull down to refresh in the installed app, which has no browser reload.
import { refreshPage } from "../live";

/** How far, in pixels, the indicator travels before a release refreshes. */
export const PULL_THRESHOLD = 64;
const MAX_PULL = 96;

const installed = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

/** Touches that belong to a control, a dialog or an open drawer never pull. */
function blocked(target: Element) {
  return Boolean(
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-no-pull-refresh]') ||
      document.querySelector("dialog[open]") ||
      document.getElementById("sidebar")?.classList.contains("open"),
  );
}

/** True when every scrolling box around the touch is at its top. */
function atTop(target: Element) {
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (el.scrollTop > 0) return false;
  }
  return (document.scrollingElement?.scrollTop ?? 0) <= 0;
}

function indicator() {
  let el = document.querySelector<HTMLElement>(".pull-refresh");
  if (el) return el;
  el = document.createElement("div");
  el.className = "pull-refresh";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
  const status = document.createElement("span");
  status.className = "pull-refresh-status";
  status.setAttribute("role", "status");
  // appendChild, since the platform's Worker types redefine append().
  document.body.appendChild(el);
  document.body.appendChild(status);
  return el;
}

function announce(text: string) {
  const status = document.querySelector(".pull-refresh-status");
  if (status) status.textContent = text;
}

function show(distance: number) {
  const el = indicator();
  el.dataset.state = distance >= PULL_THRESHOLD ? "ready" : "pulling";
  el.style.setProperty("--pull", `${distance}px`);
  el.style.setProperty("--pull-turn", `${(distance / PULL_THRESHOLD) * 270}deg`);
}

function hide() {
  const el = document.querySelector<HTMLElement>(".pull-refresh");
  if (!el) return;
  el.dataset.state = "";
  el.style.setProperty("--pull", "0px");
}

/**
 * Pulling down from the top of the page, then letting go, refreshes it with
 * `refreshPage`: the page's registered handlers, or a reload. Installed apps
 * only, since browsers have their own. Every pull refreshes; there is no
 * cooldown. Mark a region `data-no-pull-refresh` to keep its own gestures.
 */
export function installPullRefresh() {
  if (!installed()) return;
  let start: { y: number; x: number; id: number } | undefined;
  let distance = 0;
  const cancel = () => {
    start = undefined;
    distance = 0;
  };
  document.addEventListener("touchstart", (event) => {
    cancel();
    const target = event.target instanceof Element ? event.target : null;
    if (event.touches.length !== 1 || !target || blocked(target) || !atTop(target)) return;
    const touch = event.touches[0];
    start = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
  }, { passive: true });
  document.addEventListener("touchmove", (event) => {
    if (!start) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch.identifier !== start.id) {
      cancel();
      return hide();
    }
    const dy = touch.clientY - start.y, dx = Math.abs(touch.clientX - start.x);
    // An upward or sideways drag is a scroll or a sidebar swipe, not a pull.
    if (distance === 0 && (dy <= 0 || dx > dy)) {
      if (dy < 0 || dx > 8) cancel();
      return;
    }
    if (event.cancelable) event.preventDefault();
    distance = Math.min(MAX_PULL, Math.max(0, dy) * 0.5);
    show(distance);
  }, { passive: false });
  document.addEventListener("touchend", () => {
    const pulled = distance >= PULL_THRESHOLD;
    cancel();
    if (!pulled) return hide();
    const el = indicator();
    el.dataset.state = "refreshing";
    el.style.setProperty("--pull", `${PULL_THRESHOLD}px`);
    announce("Refreshing…");
    void refreshPage().finally(() => {
      announce("Refreshed");
      hide();
    });
  });
  document.addEventListener("touchcancel", () => {
    cancel();
    hide();
  });
}

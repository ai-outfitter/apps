/** Fired on `document` with the newly selected stone id as `detail`. */
export const SELECT_EVENT = "forerunner:select";

/** The stone the day view shows, from its server-rendered selection. */
export function selectedPriority() {
  return document.querySelector<HTMLElement>("[data-selected-priority]")?.dataset.selectedPriority ?? null;
}

function plainClick(event: MouseEvent) {
  return !event.defaultPrevented && event.button === 0 &&
    !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function focusSelection(board: HTMLElement, detail: HTMLElement, open: boolean) {
  if (open) detail.querySelector<HTMLElement>("h3")?.focus();
  else board.querySelector<HTMLAnchorElement>(".forerunner-stone-cards [data-priority-link]")?.focus();
}

/**
 * Same-page selection: links keep working without JavaScript, and with it a
 * click swaps the visible detail in place so the agent panel stays open.
 */
export function enhanceSelection(signal?: AbortSignal) {
  const board = document.querySelector<HTMLElement>("[data-selected-priority]");
  if (!board) return;
  const select = (id: string, moveFocus: boolean, open = true) => {
    const detail = document.getElementById(`detail-${id}`);
    if (!detail) return false;
    board.dataset.selectedPriority = id;
    for (const panel of document.querySelectorAll<HTMLElement>("[data-priority-detail]")) panel.hidden = !open || panel !== detail;
    for (const link of board.querySelectorAll<HTMLAnchorElement>(".forerunner-stone-cards [data-priority-link]")) {
      if (open && link.dataset.priorityLink === id) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
    if (moveFocus) focusSelection(board, detail, open);
    document.dispatchEvent(new CustomEvent(SELECT_EVENT, { detail: id }));
    return true;
  };
  // Client-side navigation also handles link clicks and history on this page.
  // Capture first so a selection stays in place, keeping the router's history
  // index in each entry.
  const path = location.pathname;
  document.addEventListener("click", (event) => {
    if (!plainClick(event)) return;
    const close = (event.target as Element).closest<HTMLAnchorElement>("a[data-priority-close]");
    if (close && select(board.dataset.defaultPriority ?? "", true, false)) {
      event.preventDefault();
      history.pushState({ ...history.state }, "", close.href);
      return;
    }
    const link = (event.target as Element).closest<HTMLAnchorElement>("a[data-priority-link]");
    const id = link?.dataset.priorityLink;
    if (!link || !id || !select(id, true)) return;
    event.preventDefault();
    history.pushState({ ...history.state, priority: id }, "", link.href);
  }, { capture: true, signal });
  addEventListener("popstate", (event) => {
    if (location.pathname !== path) return;
    event.stopImmediatePropagation();
    const id = new URL(location.href).searchParams.get("priority");
    if (!select(id ?? "", false)) select(board.dataset.defaultPriority ?? "", false, false);
  }, { capture: true, signal });
}

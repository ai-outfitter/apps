import { immediatePath, inspectionOccurrences, type Occurrence } from "../lib/assembly-inspection";
import type { Assembly, Item } from "../lib/assembly";
import { displayName, levelPath, occurrenceAddress, occurrencePath, parentPath } from "../lib/occurrence-address";
import { appBase } from "../lib/sections";
import type { createAssemblyViewer } from "./assembly-viewer";

type Viewer = ReturnType<typeof createAssemblyViewer>;
type ViewState = { camera?: ReturnType<Viewer["cameraPose"]>; focus?: string; tab?: string };
const storageKey = (key: string) => "workshop:inspection:" + key;
const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;

export function occurrenceInspection(
  root: HTMLElement,
  viewer: Viewer | undefined,
  signal: AbortSignal,
  renderDetails: (selected: Occurrence | undefined, level: Occurrence | undefined, tab: string) => void,
  describeLevel: (level: Occurrence) => string,
  report: (message: string) => void,
) {
  const get = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>("#" + id)!;
  const toggle = get<HTMLButtonElement>("explode-toggle");
  const range = get<HTMLInputElement>("explode-range");
  const panel = get("explode-range-panel");
  const reset = get<HTMLButtonElement>("explode-reset");
  const crumbs = get("occurrence-crumbs");
  const heading = get("project-name");
  const list = get("occurrence-list");
  const browser = get("level-browser");
  const sheetSize = get<HTMLButtonElement>("level-sheet-size");
  const motion = get<HTMLDetailsElement>("motion-menu");
  let occurrences = new Map<string, Occurrence>();
  let level: Occurrence | undefined, selected: Occurrence | undefined, parent: Occurrence | undefined;
  let rows = new Map<string, HTMLAnchorElement>();
  let amount = 0, tab = "description", canSaveCamera = false, restoring = false;
  let currentView: ViewState = {};
  let entryKey: string | undefined;
  let storageAvailable = true;

  function url(levelOccurrence: Occurrence, child?: Occurrence) {
    const href = new URL(appBase(location.pathname) + levelPath(root.dataset.slug!, levelOccurrence.path), location.origin);
    const search = new URLSearchParams(location.search);
    for (const key of ["inspect", "sel", "explode", "inspection"]) search.delete(key);
    if (child) search.set("sel", occurrenceAddress(child.path));
    if (amount) search.set("explode", String(amount));
    href.search = search.toString();
    return href;
  }
  function isPlainClick(event: MouseEvent) {
    return !event.button && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  }
  function link(label: string, href: URL) {
    const anchor = document.createElement("a");
    anchor.textContent = label;
    anchor.href = href.href;
    anchor.dataset.astroReload = "";
    return anchor;
  }
  function parentSnapshotKey(child: Occurrence) {
    const address = url(child);
    address.searchParams.delete("explode");
    return "workshop:parent-range:" + address.pathname + address.search;
  }
  function ancestorUrl(ancestor: Occurrence) {
    const path = level && immediatePath(ancestor.path, level.path);
    const child = path && occurrences.get(path);
    if (!child) return url(ancestor);
    const href = url(ancestor, child);
    try {
      const previous = sessionStorage.getItem(parentSnapshotKey(child));
      if (previous !== null) {
        if (previous === "0") href.searchParams.delete("explode");
        else href.searchParams.set("explode", previous);
      }
    } catch { /* Navigation also works without session storage. */ }
    return href;
  }
  function refreshLinks() {
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[data-level-target]")) {
      const target = occurrences.get(anchor.dataset.levelTarget!);
      if (target) anchor.href = ancestorUrl(target).href;
    }
    if (level) for (const [path, row] of rows) {
      const child = occurrences.get(path)!;
      row.href = (child.children.length ? url(child) : url(level, child)).href;
    }
  }
  function save(patch: ViewState) {
    if (!entryKey || restoring) return;
    Object.assign(currentView, patch);
    if (storageAvailable) {
      try {
        sessionStorage.setItem(storageKey(entryKey), JSON.stringify(currentView));
        return;
      } catch {
        storageAvailable = false;
      }
    }
    history.replaceState({ ...history.state, workshopView: currentView }, "");
  }
  function readEntry() {
    let key = history.state?.workshopEntry as string | undefined;
    if (!key) {
      key = crypto.randomUUID();
      history.replaceState({ ...history.state, workshopEntry: key }, "");
    }
    entryKey = key;
    try {
      currentView = JSON.parse(sessionStorage.getItem(storageKey(key)) ?? "null") ?? history.state?.workshopView ?? {};
    } catch {
      currentView = history.state?.workshopView ?? {};
    }
    return currentView;
  }
  function rememberCamera() {
    if (canSaveCamera) save({ camera: viewer?.cameraPose() });
  }
  function focusSaved(key: string | undefined) {
    const target = key ? root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"], #${CSS.escape(key)}`) : heading;
    if (target && target.getClientRects().length) target.focus({ preventScroll: !list.contains(target) });
    else heading.focus({ preventScroll: true });
  }
  function updateRows(path?: string) {
    const tip = path ?? selected?.path ?? rows.keys().next().value;
    for (const [key, row] of rows) {
      row.tabIndex = key === tip ? 0 : -1;
      if (key === selected?.path) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
  }
  function paintDetails() {
    get("occurrence-status").textContent = selected ? selected.label + " selected" : level?.label ?? "";
    updateRows();
    renderDetails(selected, level, tab);
  }
  function select(child?: Occurrence) {
    if (!level || selected === child) return;
    const camera = viewer?.cameraPose();
    history.pushState({ workshopEntry: crypto.randomUUID() }, "", url(level, child));
    readEntry();
    selected = child;
    paintDetails();
    const focused = document.activeElement as HTMLElement | null;
    save({ camera, tab, focus: focused?.dataset.focus || focused?.id || child?.path || heading.id });
  }
  function enter(child: Occurrence) {
    if (!level || !child.children.length) return;
    history.replaceState(history.state, "", url(level, child));
    save({ focus: child.path });
    try { sessionStorage.setItem(parentSnapshotKey(child), String(amount)); } catch { /* optional */ }
    rememberCamera();
    location.assign(url(child));
  }
  function goUp() {
    if (!parent) return;
    rememberCamera();
    location.assign(ancestorUrl(parent));
  }
  function setAmount(value: number, fit = true) {
    amount = clamp(value);
    range.value = String(amount);
    range.setAttribute("aria-valuetext", amount ? amount + " percent exploded" : "Assembled");
    get("explode-value").textContent = amount + "%";
    reset.hidden = amount === 0;
    viewer?.inspectLevel(level, amount);
    if (fit && canSaveCamera) viewer?.fitView();
  }
  function saveRange() {
    if (!level) return;
    const href = url(level, selected);
    if (href.href !== location.href) history.replaceState(history.state, "", href);
    refreshLinks();
    rememberCamera();
  }

  function render() {
    if (!level) return;
    heading.textContent = level.label;
    const meta = describeLevel(level);
    get("level-meta").textContent = meta;
    get("level-card-name").textContent = level.label;
    get("level-card-meta").textContent = [displayName(level.item).number, level.item.kind].filter(Boolean).join(" · ");
    browser.hidden = false;
    const count = level.children.length;
    get("level-count").textContent = count === 1 ? "1 immediate component" : count + " immediate components";
    get("level-empty").hidden = count !== 0;
    toggle.hidden = !(count && viewer);
    if (!count) panel.hidden = true;
    const authored = level.children.filter(child => child.usage?.explode).length;
    get("explode-mode").textContent = level.rigid ? "Rigid assembly" : authored ? "Authored motion" : "World Z · automatic";

    const ancestors: Occurrence[] = [];
    for (let node = parent; node; node = occurrences.get(parentPath(node.path))) ancestors.unshift(node);
    crumbs.replaceChildren(...ancestors.map(node => {
      const anchor = link(node.label, ancestorUrl(node));
      if (node === parent) {
        anchor.dataset.parent = "";
        anchor.title = "Up to " + node.label;
      }
      anchor.setAttribute("aria-label", node.label);
      anchor.dataset.levelTarget = node.path;
      anchor.dataset.focus = "crumb:" + node.path;
      return anchor;
    }));
    if (ancestors.length) {
      const here = document.createElement("span");
      here.textContent = level.label;
      here.setAttribute("aria-current", "page");
      crumbs.append(here);
    }
    rows = new Map();
    list.replaceChildren(...level.children.map(child => {
      const row = document.createElement("div");
      row.className = "level-row";
      row.setAttribute("role", "listitem");
      const pick = link(child.label, child.children.length ? url(child) : url(level!, child));
      pick.className = "level-pick";
      pick.dataset.focus = child.path;
      pick.setAttribute("aria-label", child.label);
      const meta = document.createElement("small");
      meta.textContent = [displayName(child.item).number, child.item.kind, child.usage && child.usage.quantity > 1 ? "×" + child.usage.quantity : ""].filter(Boolean).join(" · ");
      pick.append(meta);
      rows.set(child.path, pick);
      pick.onclick = event => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        if (child.children.length) enter(child);
        else select(child);
      };
      pick.onkeydown = event => {
        if (event.altKey || event.metaKey || event.ctrlKey) return;
        if (event.key === "ArrowRight" && child.children.length) {
          event.preventDefault();
          enter(child);
          return;
        }
        const options = [...rows.values()];
        const index = options.indexOf(pick);
        const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: options.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        const target = options[(next + options.length) % options.length];
        updateRows(target.dataset.focus);
        target.focus();
      };
      row.append(pick);
      if (child.children.length) {
        pick.classList.add("opens-level");
      }
      return row;
    }));
  }

  function restore() {
    if (!level) return;
    const state = readEntry();
    restoring = true;
    try {
      const query = new URLSearchParams(location.search);
      const address = query.get("sel");
      const pick = address && occurrencePath(level.path.split("/")[0], address);
      selected = level.children.find(child => child.path === pick);
      if (address && !selected) report("The selected component is unavailable at this assembly level.");
      tab = state.tab ?? (query.get("inspection") === "cots" ? "cots" : "description");
      setAmount(Number(query.get("explode")), false);
      refreshLinks();
      paintDetails();
      if (amount) {
        panel.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
      }
      if (canSaveCamera && viewer) {
        viewer.reset();
        if (state.camera) viewer.restoreCamera(state.camera);
        else if (query.get("view") === "top") viewer.topView();
      }
      if (state.focus || document.activeElement === document.body) focusSaved(state.focus);
    } finally {
      restoring = false;
    }
  }

  toggle.onclick = () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) motion.open = false;
  };
  motion.addEventListener("toggle", () => {
    if (motion.open) { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); }
  }, { signal });
  range.oninput = () => { setAmount(range.valueAsNumber); refreshLinks(); };
  range.onchange = saveRange;
  reset.onclick = () => { setAmount(0); saveRange(); toggle.focus(); };

  const heights = ["compact", "expanded", "full"];
  const sizes = ["Expand list", "Show full list", "Compact list"];
  function setSize(size: number) {
    browser.dataset.sheet = heights[size];
    sheetSize.textContent = sizes[size];
    sheetSize.setAttribute("aria-label", sizes[size]);
    sheetSize.setAttribute("aria-expanded", String(size > 0));
  }
  setSize(0);
  sheetSize.onclick = () => setSize((heights.indexOf(browser.dataset.sheet!) + 1) % heights.length);
  let swipe: { x: number; y: number } | undefined;
  browser.addEventListener("touchstart", event => {
    const point = event.touches[0];
    swipe = point && point.clientX - browser.getBoundingClientRect().left < 28 ? { x: point.clientX, y: point.clientY } : undefined;
  }, { passive: true, signal });
  browser.addEventListener("touchend", event => {
    const point = event.changedTouches[0];
    if (swipe && point && point.clientX - swipe.x > 72 && Math.abs(point.clientY - swipe.y) < 40) goUp();
    swipe = undefined;
  }, { passive: true, signal });
  root.addEventListener("focusin", event => {
    const target = event.target as HTMLElement;
    save({ focus: target.dataset.focus || target.id || undefined });
  }, { signal });
  root.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest("input,textarea,select")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (selected) select();
      else goUp();
    } else if (["ArrowLeft", "Backspace"].includes(event.key) && (list.contains(document.activeElement) || document.activeElement === heading)) {
      event.preventDefault();
      goUp();
    } else if (event.key === "ArrowDown" && document.activeElement === heading && rows.size) {
      event.preventDefault();
      (list.querySelector<HTMLElement>('[tabindex="0"]') ?? rows.values().next().value)?.focus();
    }
  }, { signal });
  window.addEventListener("popstate", restore, { signal });
  window.addEventListener("pageshow", event => { if (event.persisted) restore(); }, { signal });
  viewer?.onCameraChange(rememberCamera);

  return {
    load(assembly: Assembly) {
      canSaveCamera = false;
      occurrences = inspectionOccurrences(assembly);
      const query = new URLSearchParams(location.search);
      const rootPath = assembly.rootId ?? "";
      level = occurrences.get(rootPath);
      const address = root.dataset.level;
      const legacy = !address ? query.get("inspect") : undefined;
      const path = address ? occurrencePath(rootPath, address) : legacy;
      const target = path ? occurrences.get(path) : undefined;
      if (target?.children.length) level = target;
      else if (path || address || legacy) report("The requested inspection level is unavailable in this product and configuration.");
      parent = level && occurrences.get(parentPath(level.path));
      selected = undefined;
      if (legacy && target === level && level && parent) {
        const href = url(level);
        if (query.has("explode")) href.searchParams.set("explode", query.get("explode")!);
        if (query.has("sel")) href.searchParams.set("sel", query.get("sel")!);
        history.replaceState(history.state, "", href);
        root.dataset.level = occurrenceAddress(level.path);
      }
      render();
      restore();
    },
    ready() {
      if (!level) return;
      canSaveCamera = true;
      restoring = true;
      try {
        viewer?.reset();
        if (currentView.camera) viewer?.restoreCamera(currentView.camera);
        else if (new URLSearchParams(location.search).get("view") === "top") viewer?.topView();
      } finally {
        restoring = false;
      }
      rememberCamera();
    },
    get active() { return amount !== 0 || Boolean(parent); },
    get level() { return level; },
    get selected() { return selected; },
    setTab(name: string) { tab = name; save({ tab }); },
    clear() { select(); },
    pick(path: string, drill = false) {
      const scoped = level ? immediatePath(level.path, path) : undefined;
      const child = scoped ? occurrences.get(scoped) : undefined;
      if (!child) return;
      if (drill) enter(child);
      else select(child);
    },
    nearest(path: string, predicate: (item: Item) => boolean) {
      for (let next = path; next; next = parentPath(next)) {
        const item = occurrences.get(next)?.item;
        if (item && predicate(item)) return item;
      }
      return undefined;
    },
    href(path: string) {
      // The parent is routable even when the selected item is a leaf.
      const owner = occurrences.get(parentPath(path)), child = occurrences.get(path);
      return owner && child ? url(owner, child).href : undefined;
    },
  };
}

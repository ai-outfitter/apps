import { inspectionOccurrences, parentPath, type Occurrence } from "../lib/assembly-inspection";
import { occurrenceAddress, occurrenceTrail, occurrenceUrl } from "../lib/occurrence-route";
import type { Assembly, Item } from "../lib/assembly";
import { appBase } from "../lib/sections";
import type { createAssemblyViewer } from "./assembly-viewer";
import { assemblyTree } from "./assembly-tree";

type Viewer = ReturnType<typeof createAssemblyViewer>;
type Entry = {
  camera?: ReturnType<Viewer["cameraPose"]>;
  focus?: { id: string; path?: string };
  tab?: string;
  explodeOpen?: boolean;
  selectionCleared?: boolean;
};
const entry = (): Entry => history.state?.workshopInspection ?? {};

export function occurrenceInspection(
  root: HTMLElement,
  viewer: Viewer | undefined,
  actions: {
    changed: (selected: Occurrence | undefined, level: Occurrence | undefined) => void;
    tab: (name?: string) => string | undefined;
    hide: (path: string) => void;
    invalid: (message: string) => void;
  },
  signal: AbortSignal,
) {
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>("#" + id)!;
  const toggle = get<HTMLButtonElement>("explode-toggle");
  const range = get<HTMLInputElement>("explode-range");
  const reset = get<HTMLButtonElement>("explode-reset");
  const panel = get("explode-range-panel");
  const crumbs = get("occurrence-crumbs");
  const heading = get("project-name");
  const motion = get<HTMLDetailsElement>("motion-menu");
  const base = appBase(location.pathname);
  const slug = root.dataset.slug!;
  let assembly: Assembly;
  let occurrences: Map<string, Occurrence>;
  let top: Occurrence | undefined;
  let level: Occurrence | undefined;
  let standalone: Occurrence | undefined;
  let selected: Occurrence | undefined;
  let amount = 0;
  let ready = false;
  let restoring = false;
  let cameraTimer: number | undefined;

  const tree = assemblyTree(root, {
    href: (row, open) => open ? openHref(row) : selectionHref(row),
    pick: path => pick(path),
    hide: path => {
      const visible = viewerPath(path);
      if (visible) actions.hide(visible);
    },
  }, signal);

  function navigationQuery() {
    const query = new URLSearchParams(location.search);
    for (const key of ["item", "inspect", "sel"]) query.delete(key);
    return query;
  }
  function openHref(row: Occurrence) {
    return base + occurrenceUrl(slug, occurrenceAddress(row.path), navigationQuery());
  }
  function selectionHref(row?: Occurrence) {
    const url = new URL(location.href);
    url.searchParams.delete("sel");
    if (row && occurrences.has(row.path)) url.searchParams.set("sel", occurrenceAddress(row.path));
    return url.pathname + url.search;
  }
  function byAddress(address: string | null) {
    const target = address !== null && occurrenceTrail(assembly, address)?.at(-1);
    return target ? occurrences.get(target.path) : undefined;
  }
  function focusState(target: Element | null): Entry["focus"] {
    if (target instanceof HTMLElement && root.contains(target)) {
      const row = target.closest<HTMLElement>("[data-tree-path]");
      if (row) return { id: "inspection-tree", path: row.dataset.treePath };
      const crumb = target.closest<HTMLElement>("[data-crumb]");
      if (crumb) return { id: "occurrence-crumbs", path: crumb.dataset.crumb };
      if (target.id) return { id: target.id };
    }
    return undefined;
  }
  function save(patch: Entry, url?: string) {
    history.replaceState({ ...history.state, workshopInspection: { ...entry(), ...patch } }, "", url);
  }
  function saveCamera() {
    window.clearTimeout(cameraTimer);
    if (ready && viewer && !restoring) save({ camera: viewer.cameraPose() });
  }
  viewer?.onCameraChange(() => {
    if (!ready || restoring) return;
    window.clearTimeout(cameraTimer);
    cameraTimer = window.setTimeout(saveCamera, 120);
  });
  signal.addEventListener("abort", () => window.clearTimeout(cameraTimer), { once: true });
  window.addEventListener("pagehide", saveCamera, { signal });
  root.addEventListener("focusin", event => {
    if (occurrences && !restoring) {
      const focus = focusState(event.target as Element);
      if (focus) save({ focus });
    }
  }, { signal });
  // Capture the initiating focus and the orbit before a native document link runs.
  root.addEventListener("click", event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
    if (!link || !occurrences || event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    saveCamera();
    const focus = focusState(document.activeElement) ?? focusState(link);
    if (focus) save({ focus });
  }, { signal, capture: true });

  function restoreFocus(focus: Entry["focus"]) {
    if (!focus) return;
    if (focus.id === "inspection-tree" && focus.path && tree.restoreFocus(focus.path)) return;
    if (focus.id === "occurrence-crumbs" && focus.path) {
      crumbs.querySelector<HTMLElement>(`a[data-crumb="${CSS.escape(focus.path)}"]`)?.focus({ preventScroll: true });
      return;
    }
    get(focus.id)?.focus({ preventScroll: true });
  }
  function showRange(open: boolean) {
    panel.hidden = !open || toggle.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  }
  function viewerLevel(row?: Occurrence): Occurrence | undefined {
    if (!standalone || !row) return row;
    return { ...row, path: viewerPath(row.path) ?? standalone.item.id,
      children: row.children.map(child => ({ ...child, path: viewerPath(child.path) ?? child.path })) };
  }
  function viewerPath(path?: string) {
    if (!standalone || !path) return path;
    if (path === standalone.path || path.startsWith(standalone.path + "/")) {
      return standalone.item.id + path.slice(standalone.path.length);
    }
    return undefined;
  }
  function setAmount(value: number) {
    amount = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
    range.value = String(amount);
    range.setAttribute("aria-valuetext", amount ? amount + " percent exploded" : "Assembled");
    get("explode-value").textContent = amount + "%";
    reset.hidden = amount === 0 || toggle.hidden;
    viewer?.inspectLevel(viewerLevel(level), amount);
  }
  function updateAmount(value: number) {
    setAmount(value);
    viewer?.fit();
    const url = new URL(location.href);
    if (amount) url.searchParams.set("explode", String(amount));
    else url.searchParams.delete("explode");
    save({}, url.href);
    tree.updateLinks();
    updateCrumbs();
    saveCamera();
  }
  function trailFor(row = level) {
    const trail: Occurrence[] = [];
    while (row) {
      trail.unshift(row);
      row = occurrences.get(parentPath(row.path));
    }
    return trail;
  }
  function updateCrumbs() {
    const trail = trailFor();
    crumbs.replaceChildren(...trail.map(row => {
      const crumb = document.createElement(row.path === level?.path ? "span" : "a");
      crumb.textContent = row.label;
      if (crumb instanceof HTMLAnchorElement) {
        crumb.href = openHref(row);
        crumb.dataset.crumb = row.path;
      } else crumb.setAttribute("aria-current", "page");
      return crumb;
    }));
    crumbs.hidden = trail.length < 2;
  }
  function changeSelection(row?: Occurrence) {
    selected = row;
    tree.select(row?.path);
    actions.changed(row, level);
  }
  function pick(path?: string) {
    const row = path ? occurrences.get(path) ?? (standalone?.path === path ? standalone : undefined) : undefined;
    if (row === selected) return;
    const url = selectionHref(row);
    saveCamera();
    const focus = focusState(document.activeElement);
    const previous = entry();
    history.pushState({ workshopInspection: { ...previous, focus, selectionCleared: !row } }, "", url);
    changeSelection(row);
  }
  function restoreHistory() {
    restoring = true;
    const saved = entry();
    const query = new URLSearchParams(location.search);
    setAmount(Number(query.get("explode")));
    showRange(saved.explodeOpen ?? amount > 0);
    if (ready && saved.camera) viewer?.restoreCamera(saved.camera);
    if (ready && !saved.camera) {
      if (query.get("view") === "top") viewer?.topView();
      else viewer?.reset();
    }
    const selection = byAddress(query.get("sel"));
    changeSelection(selection ?? (standalone && !query.has("sel") && !saved.selectionCleared ? standalone : undefined));
    actions.tab(saved.tab ?? (query.get("inspection") === "cots" ? "cots" : undefined));
    tree.updateLinks();
    updateCrumbs();
    restoreFocus(saved.focus);
    restoring = false;
  }

  toggle.onclick = () => {
    showRange(Boolean(panel.hidden));
    save({ explodeOpen: !panel.hidden });
    if (!panel.hidden) motion.open = false;
  };
  motion.addEventListener("toggle", () => {
    if (motion.open && !panel.hidden) {
      showRange(false);
      save({ explodeOpen: false });
    }
  }, { signal });
  range.oninput = () => updateAmount(range.valueAsNumber);
  reset.onclick = () => { updateAmount(0); toggle.focus(); };
  window.addEventListener("popstate", () => {
    window.clearTimeout(cameraTimer);
    if (occurrences) restoreHistory();
  }, { signal });
  window.addEventListener("pageshow", event => {
    if (event.persisted && occurrences) {
      tree.refreshExpansion();
      restoreHistory();
    }
  }, { signal });
  root.addEventListener("keydown", event => {
    if (event.key !== "Escape" || (event.target as Element).closest("dialog, [data-disclosure], input, textarea, select")) return;
    if (selected) pick();
    else {
      const ancestor = level && occurrences.get(parentPath(level.path));
      if (!ancestor) return;
      location.assign(openHref(ancestor));
    }
    event.preventDefault();
  }, { signal });

  return {
    load(next: Assembly, focused?: Item) {
      ready = false;
      assembly = next;
      occurrences = inspectionOccurrences(next);
      top = occurrences.get(next.rootId ?? "");
      standalone = undefined;
      const query = new URLSearchParams(location.search);
      level = root.dataset.openAddress ? byAddress(root.dataset.openAddress) : top;
      if (root.dataset.openAddress && level?.item.kind !== "assembly") {
        actions.invalid("This assembly occurrence no longer exists in the selected revision.");
        level = undefined;
      } else if (!root.dataset.openAddress && query.has("inspect")) {
        const legacy = occurrences.get(query.get("inspect")!);
        if (legacy?.item.kind === "assembly") level = legacy;
        else actions.invalid("That saved inspection path is unavailable. The installed assembly is shown.");
      } else if (!root.dataset.openAddress && focused && focused.id !== top?.item.id) {
        standalone = [...occurrences.values()].find(row => row.item.id === focused.id)
          ?? inspectionOccurrences({ ...next, rootId: focused.id }).get(focused.id);
        level = standalone;
        // Standalone model URLs retain their item-local camera and motion controls.
        const local = standalone && inspectionOccurrences({ ...next, rootId: focused.id }).get(focused.id);
        if (local && standalone) {
          const rebase = (row: Occurrence): Occurrence => ({ ...row,
            path: standalone!.path + row.path.slice(focused.id.length), children: row.children.map(rebase) });
          level = rebase(local);
        }
      }
      const selected = byAddress(query.get("sel"));
      if (query.has("sel") && !selected) actions.invalid("That selected component is unavailable in this assembly.");
      tree.load("workshop-tree:" + base + "/" + slug + ":" + top?.path, top, level, selected?.path);
      updateCrumbs();
      const canExplode = Boolean(level?.children.length);
      toggle.hidden = !canExplode;
      toggle.disabled = true;
      range.disabled = true;
      const authored = level?.children.filter(child => child.usage?.explode).length ?? 0;
      get("explode-direction").textContent = authored
        ? authored === level?.children.length ? "Authored offsets" : "Authored offsets · auto world Z"
        : "World Z · automatic";
      changeSelection(selected ?? (entry().selectionCleared ? undefined : standalone));
      setAmount(Number(query.get("explode")));
      showRange(entry().explodeOpen ?? amount > 0);
      return !root.dataset.openAddress || Boolean(level);
    },
    ready() {
      ready = true;
      toggle.disabled = false;
      range.disabled = false;
      const saved = entry();
      const query = new URLSearchParams(location.search);
      // Mesh rendering fits after applying the exploded world transforms.
      if (saved.camera) {
        restoring = true;
        viewer?.restoreCamera(saved.camera);
        restoring = false;
      } else if (query.get("view") === "top") viewer?.topView();
      saveCamera();
      if (saved.focus) restoreFocus(saved.focus);
      else if (root.dataset.openAddress && document.activeElement === document.body) heading.focus({ preventScroll: true });
    },
    tabChanged(tab: string) {
      if (!restoring && occurrences) save({ tab });
    },
    get savedTab() { return entry().tab; },
    get active() { return amount !== 0 || level !== top; },
    get level() { return level; },
    trailFor,
    setHidden: tree.setHidden,
    pathFor(id: string) {
      const scope = selected?.path ?? level?.path;
      const candidates = [...occurrences.values()].filter(row => row.item.id === id);
      return (scope && candidates.find(row => row.path.startsWith(scope + "/"))) || candidates[0];
    },
    hrefFor: selectionHref,
    openHref,
    pick,
    clear: () => pick(),
    fromViewer(path: string) {
      return standalone ? standalone.path + path.slice(standalone.item.id.length) : path;
    },
    viewerPath,
    open(path: string) {
      const row = occurrences.get(path);
      if (row && row !== level && row.item.kind === "assembly") location.assign(openHref(row));
    },
  };
}

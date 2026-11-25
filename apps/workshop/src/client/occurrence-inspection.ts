import { inspectionOccurrences, type Occurrence } from "../lib/assembly-inspection";
import type { Assembly, Item } from "../lib/assembly";
import type { createAssemblyViewer } from "./assembly-viewer";

type Viewer = ReturnType<typeof createAssemblyViewer>;
export function occurrenceInspection(root: HTMLElement, viewer: Viewer, select: (item: Item, path: string) => void, clear: () => void, changed: (level: Occurrence) => void) {
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>("#" + id)!;
  const toggle = get<HTMLButtonElement>("explode-toggle");
  const range = get<HTMLInputElement>("explode-range");
  const reset = get<HTMLButtonElement>("explode-reset");
  const panel = get("explode-range-panel");
  const crumbs = get("occurrence-crumbs");
  const heading = get("occurrence-heading");
  const list = get("occurrence-list");
  const back = get<HTMLButtonElement>("occurrence-back");
  const motion = get<HTMLDetailsElement>("motion-menu");
  let occurrences = new Map<string, Occurrence>();
  let level: Occurrence | undefined;
  let amount = 0;
  let selectedPath: string | undefined;
  const stack: {level: Occurrence; amount: number; camera?: ReturnType<Viewer["cameraPose"]>; selected: Occurrence}[] = [];

  function button(label: string, action: () => void) {
    const control = document.createElement("button");
    control.textContent = label; control.onclick = action;
    return control;
  }
  function setAmount(value: number, bookmark = true) {
    amount = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
    range.value = String(amount);
    range.setAttribute("aria-valuetext", amount ? amount + " percent exploded" : "Assembled");
    get("explode-value").textContent = amount + "%";
    reset.hidden = amount === 0;
    viewer.inspectLevel(level, amount);
    if (bookmark) {
      const url = new URL(location.href);
      if (amount) url.searchParams.set("explode", String(amount)); else url.searchParams.delete("explode");
      if (stack.length && level) url.searchParams.set("inspect", level.path); else url.searchParams.delete("inspect");
      history.replaceState(history.state, "", url);
    }
  }
  function enter(child: Occurrence) {
    if (!level || !child.children.length) return;
    stack.push({level, amount, camera:viewer.cameraPose(), selected:child});
    level = child;
    clear();
    render(); changed(child); setAmount(0); viewer.reset(); heading.focus();
  }
  function leave(depth: number) {
    const saved = stack[depth];
    if (!saved) return;
    stack.splice(depth);
    level = saved.level;
    clear(); render(); changed(saved.level); setAmount(saved.amount);
    if (saved.camera) viewer.restoreCamera(saved.camera); else viewer.reset();
    select(saved.selected.item, saved.selected.path);
    list.closest("details")!.open = true;
    list.querySelector<HTMLButtonElement>(`[data-occurrence="${CSS.escape(saved.selected.path)}"]`)?.focus();
  }
  function render() {
    const enabled = Boolean(level?.children.length);
    toggle.hidden = !enabled;
    get("occurrence-inspection").hidden = !enabled;
    if (!enabled || !level) { panel.hidden = true; return; }
    heading.hidden = !stack.length;
    crumbs.hidden = !stack.length;
    heading.textContent = "Inspecting " + level.item.name;
    get("occurrence-status").textContent = "Inspecting " + level.item.name;
    crumbs.replaceChildren();
    for (const [depth, frame] of stack.entries()) crumbs.append(button(frame.level.item.name, () => leave(depth)));
    
    back.hidden = !stack.length;
    list.replaceChildren();
    for (const child of level.children) {
      const row = document.createElement("div");
      const pick = button(child.label, () => select(child.item, child.path));
      pick.dataset.occurrence = child.path;
      pick.setAttribute("aria-pressed",String(selectedPath === child.path));
      row.append(pick);
      if (child.children.length) row.append(button("Inspect " + child.label, () => enter(child)));
      list.append(row);
    }
  }
  toggle.onclick = () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) motion.open = false;
  };
  motion.addEventListener("toggle", () => {
    if (motion.open) { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); }
  });
  range.oninput = () => setAmount(range.valueAsNumber);
  reset.onclick = () => {setAmount(0); toggle.focus();};
  back.onclick = () => leave(stack.length - 1);
  return {
    load(assembly: Assembly) {
      occurrences = inspectionOccurrences(assembly);
      level = occurrences.get(assembly.rootId ?? "");
      stack.length = 0; selectedPath = undefined; toggle.disabled = true; range.disabled = true;
      const query = new URLSearchParams(location.search);
      const target = occurrences.get(query.get("inspect") ?? "");
      const path = target?.path;
      while (level && path && level.path !== path) {
        const next: Occurrence | undefined = level.children.find(child => path === child.path || path.startsWith(child.path + "/"));
        if (!next?.children.length) break;
        stack.push({level, amount:0, selected:next});
        level = next;
      }
      render(); setAmount(Number(query.get("explode")), false);
    },
    ready() { toggle.disabled = false; range.disabled = false; },
    clear() {
      selectedPath = undefined;
      get("occurrence-status").textContent = level ? "Inspecting " + level.item.name : "";
      for (const row of list.querySelectorAll("[data-occurrence]")) row.setAttribute("aria-pressed","false");
    },
    get active() { return amount !== 0 || stack.length > 0; },
    selected(item: Item, path: string | undefined, host: HTMLElement) {
      const child = path ? occurrences.get(path) : undefined;
      selectedPath = path;
      for (const row of list.querySelectorAll<HTMLElement>("[data-occurrence]")) row.setAttribute("aria-pressed",String(row.dataset.occurrence === path));
      get("occurrence-status").textContent = item.name + " selected";
      if (child?.children.length && level?.children.includes(child)) host.prepend(button("Inspect " + child.label, () => enter(child)));
    }
  };
}

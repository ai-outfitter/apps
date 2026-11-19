import { assemblyChildren } from "../lib/model-catalog";
import type { Assembly, Item } from "../lib/assembly";
import type { ResolvedAssembly } from "../lib/assembly-resolution";

export function projectInspection(host: HTMLElement, onOpen: (name: string) => void) {
 const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
 function open(name: string) {
  for (const tab of tabs) {
   const active = tab.id === "tab-" + name;
   tab.setAttribute("aria-selected", String(active));
   tab.tabIndex = active ? 0 : -1;
   host.querySelector<HTMLElement>("#" + tab.getAttribute("aria-controls"))!.hidden = !active;
  }
  onOpen(name);
 }
 for (const tab of tabs) {
  tab.onclick = () => open(tab.id.slice(4));
  tab.onkeydown = event => {
   const visible = tabs.filter(button => !button.hidden);
   const index = visible.indexOf(tab);
   const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: visible.length - 1 }[event.key];
   if (next === undefined) return;
   event.preventDefault();
   const target = visible[(next + visible.length) % visible.length];
   target.focus();
   target.click();
  };
 }
 host.querySelector<HTMLButtonElement>("#back-components")!.onclick = () => {
  open("components");
  host.querySelector<HTMLButtonElement>("#tab-components")!.focus();
 };
 return {open};
}

export function inspectionTree(assembly: Assembly, sources: ResolvedAssembly["sources"], sourceUrl: (source: ResolvedAssembly["sources"][number]) => string, select: (item: Item) => void) {
 function branch(parent: string | undefined, expandOnlyChild = false) {
  const list = document.createElement("ul");
  const children = assemblyChildren(assembly, parent);
  for (const {item, quantity} of children) {
   const row = document.createElement("li");
   const line = document.createElement("div");
   line.className = "tree-line";
   const pick = document.createElement("button");
   pick.textContent = item.name;
   pick.onclick = () => select(item);
   const source = sources.find(s => s.itemId === item.id);
   const meta = document.createElement("small");
   meta.textContent = item.number + " · " + item.kind + (quantity > 1 ? " ×" + quantity : "");
   line.append(pick, meta);
   if (source) {
    const link = document.createElement("a");
    link.textContent = "Source · rev " + source.revision;
    link.href = sourceUrl(source);
    line.append(link);
   }
   row.append(line);
   if (item.uses.length) {
    const expand = document.createElement("button");
    expand.className = "tree-toggle";
    expand.textContent = "▸";
    expand.setAttribute("aria-label", "Expand " + item.name);
    expand.setAttribute("aria-expanded", "false");
    line.prepend(expand);
    let nested: HTMLUListElement | undefined;
    expand.onclick = () => {
     const opening = expand.getAttribute("aria-expanded") !== "true";
     if (!nested) { nested = branch(item.id); row.append(nested); }
     nested.hidden = !opening;
     expand.textContent = opening ? "▾" : "▸";
     expand.setAttribute("aria-expanded", String(opening));
     expand.setAttribute("aria-label", (opening ? "Collapse " : "Expand ") + item.name);
    };
    if (expandOnlyChild && children.length === 1) expand.click();
   }
   list.append(row);
  }
  return list;
 }
 return branch(assembly.rootId, true);
}

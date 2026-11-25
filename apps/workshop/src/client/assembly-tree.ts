import { componentIdentity } from "../lib/occurrence-route";
import { parentPath, type Occurrence } from "../lib/assembly-inspection";

export function assemblyTree(
  root: HTMLElement,
  actions: {
    href: (row: Occurrence, open: boolean) => string;
    pick: (path: string) => void;
    hide: (path: string) => void;
  },
  signal: AbortSignal,
) {
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>("#" + id)!;
  const host = get("inspection-tree");
  const filter = get<HTMLInputElement>("tree-filter");
  const dock = get("inspection-tree-dock");
  const sidebar = get("assembly-navigator");
  const drawer = get<HTMLDialogElement>("tree-drawer");
  const trigger = get("tree-drawer-open");
  const mobile = matchMedia("(max-width: 920px)");
  let top: Occurrence | undefined;
  let current: Occurrence | undefined;
  let selected: string | undefined;
  let cursor = "";
  let storageKey = "";
  let expanded = new Set<string>();
  let hidden: ReadonlySet<string> = new Set();
  let nodes = new Map<string, { node: HTMLElement; row: Occurrence; line: HTMLElement; hide?: HTMLButtonElement }>();
  let search = "";
  let lastTyped = 0;
  let typed = "";

  function placeSidebar() {
    if (!mobile.matches && drawer.open) drawer.close();
    (mobile.matches ? drawer : dock).append(sidebar);
  }
  mobile.addEventListener("change", placeSidebar, { signal });
  placeSidebar();
  trigger.onclick = () => {
    drawer.showModal();
    if (!focus(cursor)) filter.focus();
  };
  get("tree-drawer-close").onclick = () => drawer.close();
  drawer.addEventListener("click", event => {
    if (event.target === drawer) drawer.close();
  }, { signal });
  drawer.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      drawer.close();
    }
  }, { signal });
  drawer.addEventListener("close", () => {
    if (mobile.matches) trigger.focus();
  }, { signal });
  get("inspection-details-open").onclick = () => {
    get("selected-name").focus();
    get("project-inspection").scrollIntoView({ block: "start" });
  };

  function persist() {
    try { sessionStorage.setItem(storageKey, JSON.stringify([...expanded])); }
    catch { /* Expansion still works when storage is unavailable. */ }
  }
  function reveal(path?: string) {
    while (path) {
      expanded.add(path);
      path = parentPath(path);
    }
  }
  function focus(path: string) {
    const entry = nodes.get(path);
    if (!entry) return false;
    nodes.get(cursor)?.node.setAttribute("tabindex", "-1");
    cursor = path;
    entry.node.tabIndex = 0;
    entry.node.focus();
    return true;
  }
  function toggle(path: string) {
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    persist();
    render();
    focus(path);
  }
  function decorate() {
    for (const [path, { node, row, line, hide }] of nodes) {
      const open = current?.path === path;
      const ancestor = current?.path.startsWith(path + "/");
      const outside = current && !open && !ancestor && !path.startsWith(current.path + "/");
      node.setAttribute("aria-selected", String(path === selected));
      line.toggleAttribute("data-open", open);
      line.toggleAttribute("data-ancestor", Boolean(ancestor));
      line.toggleAttribute("data-outside", Boolean(outside));
      if (open) node.setAttribute("aria-current", "location");
      else node.removeAttribute("aria-current");
      const link = line.querySelector<HTMLAnchorElement>("a[data-open-assembly]");
      if (link) link.href = actions.href(row, true);
      line.querySelector<HTMLAnchorElement>("a[data-pick]")!.href = actions.href(row, false);
      if (hide) {
        const invisible = hidden.has(path);
        hide.textContent = invisible ? "⊘" : "◉";
        hide.setAttribute("aria-label", (invisible ? "Show " : "Hide ") + row.label);
        line.toggleAttribute("data-hidden", invisible);
      }
    }
  }
  function render() {
    nodes = new Map();
    const matches = new Set<string>();
    if (search && top) {
      const find = (row: Occurrence): boolean => {
        const childMatches = row.children.map(find).some(Boolean);
        const match = childMatches || [row.label, row.item.number, row.item.mpn, row.item.manufacturer]
          .some(value => value.toLowerCase().includes(search));
        if (match) matches.add(row.path);
        return match;
      };
      find(top);
    }
    function branch(row: Occurrence, ancestors: string[], level: number): HTMLElement {
      const hasChildren = row.children.length > 0;
      const open = hasChildren && (search ? row.children.some(child => matches.has(child.path)) : expanded.has(row.path));
      const node = document.createElement("li");
      node.setAttribute("role", "treeitem");
      node.setAttribute("aria-label", row.label);
      node.tabIndex = -1;
      node.dataset.treePath = row.path;
      if (hasChildren) node.setAttribute("aria-expanded", String(open));
      const line = document.createElement("div");
      line.className = "assembly-tree-row";
      line.style.setProperty("--depth", String(Math.min(level - 1, 3)));
      if (hasChildren) {
        const button = document.createElement("button");
        button.className = "tree-chevron";
        button.textContent = open ? "▾" : "▸";
        button.tabIndex = -1;
        button.setAttribute("aria-label", (open ? "Collapse " : "Expand ") + row.label);
        button.disabled = Boolean(search);
        button.onclick = () => toggle(row.path);
        line.append(button);
      }
      const pick = document.createElement("a");
      pick.className = "tree-pick";
      pick.dataset.pick = "";
      pick.tabIndex = -1;
      const name = document.createElement("strong");
      name.textContent = row.label;
      const meta = document.createElement("small");
      meta.textContent = (level > 4 ? ancestors.slice(1).join(" › ") + " · " : "") +
        [componentIdentity(row.item).number, row.item.kind, row.usage && row.usage.quantity > 1 ? "×" + row.usage.quantity : ""].filter(Boolean).join(" · ");
      pick.append(name, meta);
      pick.onclick = event => {
        if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        focus(row.path);
        actions.pick(row.path);
      };
      line.append(pick);
      if (row.item.kind === "assembly") {
        const openLink = document.createElement("a");
        openLink.dataset.openAssembly = "";
        openLink.className = "tree-open-assembly";
        openLink.textContent = "↗";
        openLink.setAttribute("aria-label", "Inspect " + row.label);
        openLink.title = "Open assembly";
        openLink.tabIndex = -1;
        line.append(openLink);
        pick.ondblclick = () => openLink.click();
      }
      let hide: HTMLButtonElement | undefined;
      if (row !== top) {
        hide = document.createElement("button");
        hide.className = "tree-hide";
        hide.tabIndex = -1;
        hide.onclick = () => actions.hide(row.path);
        line.append(hide);
      }
      node.append(line);
      nodes.set(row.path, { node, row, line, hide });
      if (open) {
        const group = document.createElement("ul");
        group.setAttribute("role", "group");
        const parents = [...ancestors, row.label];
        for (const child of row.children) {
          if (!search || matches.has(child.path)) group.append(branch(child, parents, level + 1));
        }
        node.append(group);
      }
      return node;
    }
    if (!top || search && !matches.size) {
      host.textContent = top ? "No components match this search." : "No installed assembly is available.";
      return;
    }
    const tree = document.createElement("ul");
    tree.setAttribute("role", "tree");
    tree.setAttribute("aria-label", "Installed components");
    tree.append(branch(top, [], 1));
    host.replaceChildren(tree);
    cursor = nodes.has(cursor) ? cursor : [selected, current?.path, top.path].find(path => path && nodes.has(path)) ?? top.path;
    nodes.get(cursor)!.node.tabIndex = 0;
    decorate();
  }
  filter.oninput = () => {
    search = filter.value.trim().toLowerCase();
    render();
  };

  host.onkeydown = event => {
    const path = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-path]")?.dataset.treePath;
    if (!path || !nodes.has(path)) return;
    const paths = [...nodes.keys()];
    const index = paths.indexOf(path);
    const { row, line } = nodes.get(path)!;
    const child = row.children.find(entry => nodes.has(entry.path));
    switch (event.key) {
      case "ArrowDown": focus(paths[index + 1]); break;
      case "ArrowUp": focus(paths[index - 1]); break;
      case "Home": focus(paths[0]); break;
      case "End": focus(paths.at(-1)!); break;
      case "ArrowRight":
        if (child) focus(child.path);
        else if (row.children.length && !search) toggle(path);
        break;
      case "ArrowLeft":
        if (child && !search) toggle(path);
        else focus(parentPath(path));
        break;
      case "Enter":
        if (event.shiftKey) line.querySelector<HTMLAnchorElement>("a[data-open-assembly]")?.click();
        else actions.pick(path);
        break;
      case " ":
        actions.pick(path);
        break;
      default: {
        if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return;
        typed = (performance.now() - lastTyped > 700 ? "" : typed) + event.key.toLowerCase();
        lastTyped = performance.now();
        const candidates = paths.slice(index + 1).concat(paths.slice(0, index + 1));
        const match = candidates.find(candidate => {
          const { row } = nodes.get(candidate)!;
          return [row.item.name, row.label, row.item.number].some(value => value.toLowerCase().startsWith(typed));
        });
        if (match) focus(match);
      }
    }
    event.preventDefault();
  };
  function refreshExpansion() {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) expanded = new Set(JSON.parse(saved));
    } catch { /* Use the current expansion if storage is unavailable. */ }
    reveal(current?.path);
    reveal(selected && parentPath(selected));
    render();
  }
  return {
    load(key: string, assembly: Occurrence | undefined, open: Occurrence | undefined, pick?: string) {
      if (storageKey !== key) expanded = new Set();
      storageKey = key;
      top = assembly;
      current = open;
      selected = pick;
      refreshExpansion();
      persist();
    },
    refreshExpansion,
    select(path?: string) {
      selected = path;
      if (path && !nodes.has(path) && !search) {
        reveal(parentPath(path));
        persist();
        render();
      } else decorate();
    },
    updateLinks: decorate,
    setHidden(paths: ReadonlySet<string>) {
      hidden = paths;
      decorate();
    },
    restoreFocus(path: string) {
      if (mobile.matches && !drawer.open) drawer.showModal();
      return focus(path);
    },
  };
}

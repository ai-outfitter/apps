import type { Graph } from "../lib/graph";
import { knowledgeGraphsFor } from "../lib/knowledge-graphs";
import { appUrl, el, entityUrl, loadGraph, typeSegment } from "./data";

const rendered = new WeakMap<HTMLElement, { graph: Graph; path: string }>();
const primaryTypes = ["Organization", "Project", "Product", "ProductRevision", "Document", "Person", "Role", "RoleAssignment"];
function rootSections(graph: Graph) {
  const onHome = location.pathname.replace(/\/$/, "") === appUrl().replace(/\/$/, "");
  const current = graph.nodes.find(node => !node.archived && (onHome ? node.id === graph.home?.organizationId :
    location.pathname === entityUrl(node.id) || location.pathname.startsWith(`${entityUrl(node.id)}/`)));
  const types = graph.types.filter(type => !type.archived && type.category === "node" &&
    (primaryTypes.includes(type.name) || type.id === current?.typeId))
    .sort((a, b) => primaryTypes.indexOf(a.name) - primaryTypes.indexOf(b.name));
  const home = el("a", { class: "chat-link", href: appUrl(), ...(onHome ? { "aria-current": "page" } : {}) }, "Home");
  const charter = graph.nodes.find(node => !node.archived && node.id === graph.home?.charterId);
  return [home, ...(graph.home?.organizationId ? [el("a", { class: "chat-link", href: `${entityUrl(graph.home.organizationId)}/org-chart`, ...(location.pathname.endsWith("/org-chart") ? { "aria-current": "page" } : {}) }, "Org chart")] : []), ...(charter ? [el("a", { class: "chat-link", href: entityUrl(charter.id) }, "Organization charter")] : []), ...types.map(type => {
    const href = appUrl(typeSegment(type.name));
    const section = el("section", { class: "wiki-root-section" },
      el("a", { class: "chat-link", href, ...(location.pathname.replace(/\/$/, "") === href ? { "aria-current": "page" } : {}) }, type.title));
    if (current?.typeId === type.id) {
      const rootPath = entityUrl(current.id);
      const link = el("a", { href: rootPath, "aria-current": "page" }, current.title);
      link.dataset.rootPath = rootPath;
      const lenses = knowledgeGraphsFor(graph, current);
      section.appendChild(el("ul", { class: "wiki-root-nodes", "aria-label": `${type.title} knowledge graph roots` },
        el("li", {}, link, ...(lenses.length ? [el("ul", { class: "wiki-root-graphs", "aria-label": `Knowledge graphs for ${current.title}` },
          ...lenses.map(({ node }) => {
            const graphHref = `${rootPath}/knowledge-graphs/${encodeURIComponent(node.id)}`;
            return el("li", {}, el("a", { href: graphHref, ...(location.pathname === graphHref ? { "aria-current": "page" } : {}) }, node.title));
          }))] : []))));
    }
    return section;
  })];
}
function renderSidebar() {
  const sidebar = document.querySelector<HTMLElement>("[data-sidebar-graphs]");
  if (sidebar) void loadGraph().then(graph => {
    const previous = rendered.get(sidebar);
    if (!sidebar.isConnected || (previous?.graph === graph && previous.path === location.pathname)) return;
    rendered.set(sidebar, { graph, path: location.pathname });
    sidebar.replaceChildren(...rootSections(graph));
  }).catch(() => { sidebar.textContent = "Unable to load navigation."; });
}
document.addEventListener("astro:page-load", renderSidebar);
renderSidebar();

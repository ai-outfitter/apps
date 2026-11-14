import { createKnowledgeGraphViewer, disposeKnowledgeGraphViewers } from "@ai-outfitter/ui/knowledge-graph";
import type { Graph } from "../lib/graph";
import { slugify } from "../lib/graph";
import { exploreKnowledgeGraph, knowledgeGraphsFor } from "../lib/knowledge-graphs";
import { appUrl, call, demoMode, el, entityUrl, loadGraph, typeName } from "./data";

type ExplorationSummary = { slug: string; title: string };

/** Saved explorations, and a form that starts one from any record (organizations first). */
async function explorations(graph: Graph) {
  if (demoMode) {
    const { demoExplorations } = await import("../../fixtures/exploration");
    return el("div", { class: "explorations" }, el("h2", {}, "Explorations"),
      el("ul", { class: "exploration-list" }, ...demoExplorations.map((item) => el("li", {}, el("a", { href: appUrl(`explore/${encodeURIComponent(item.slug)}`) }, item.title)))));
  }
  const saved = await call<ExplorationSummary[]>("explorations/list").catch(() => [] as ExplorationSummary[]);
  const records = graph.nodes.filter((node) => !node.archived && node.slug).sort((a, b) =>
    Number(typeName(graph, b.typeId) === "Organization") - Number(typeName(graph, a.typeId) === "Organization") || a.title.localeCompare(b.title));
  const start = el("select", { name: "start" }, ...records.map((node) => el("option", { value: node.id }, `${node.title} · ${typeName(graph, node.typeId)}`)));
  const problem = el("p", { role: "alert", hidden: true });
  const form = el("form", { class: "exploration-start" }, el("label", {}, "Start from", start), el("button", { type: "submit" }, "Explore"), problem);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const node = records.find((item) => item.id === start.value);
    if (!node?.slug) return;
    const slug = `${slugify(node.title) || "exploration"}-${Date.now().toString(36)}`.slice(0, 64);
    try {
      await call("explorations/mutate", { slug, expectedRevision: 0, patch: { title: node.title, start: { type: typeName(graph, node.typeId), slug: node.slug } } });
      location.assign(appUrl(`explore/${slug}`));
    } catch (error) { problem.hidden = false; problem.textContent = String(error instanceof Error ? error.message : error); }
  };
  return el("div", { class: "explorations" },
    el("h2", {}, "Explorations"),
    el("p", {}, "A view you and agents change together: open offerings, projects or competitors from a record, and Ask Onto's changes appear when it replies."),
    ...(saved.length ? [el("ul", { class: "exploration-list" }, ...saved.map((item) => el("li", {}, el("a", { href: appUrl(`explore/${item.slug}`) }, item.title))))] : []),
    ...(records.length ? [form] : []),
  );
}

async function renderExplorer() {
  const root = document.getElementById("graph-explorer");
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = "true";
  try {
    const graph = await loadGraph();
    if (!root.isConnected) return;
    root.setAttribute("aria-busy", "false");
    root.closest(".ui-content")?.classList.add("wiki-graph-content");
    const nodes = graph.nodes.filter((node) => !node.archived).sort((a, b) => a.title.localeCompare(b.title));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => !edge.archived && nodeIds.has(edge.fromId) && nodeIds.has(edge.toId));
    const select = (items: [string, string][]) => el("select", {}, ...items.map(([value, title]) => el("option", { value }, title)));
    const types = (category: "node" | "edge", used: Set<string>) => graph.types.filter((type) => !type.archived && type.category === category && used.has(type.id)).sort((a, b) => a.title.localeCompare(b.title)).map((type): [string, string] => [type.id, type.title]);
    const entityType = select([["", "All entity types"], ...types("node", new Set(nodes.map((n) => n.typeId)))]);
    const relationshipType = select([["", "All relationship types"], ...types("edge", new Set(edges.map((e) => e.typeId)))]);
    const anchor = select([["", "Entire Wiki"], ...nodes.map((node): [string, string] => [node.id, node.title])]);
    const lens = select([["", "Direct connections"]]);
    const search = el("input", { type: "search", placeholder: "Search entity names" });
    const output = el("div", { class: "wiki-map" });
    const field = (name: string, control: Node) => el("label", {}, name, control);
    const controls = el("div", { class: "graph-explorer-filters" }, field("Search", search), field("Entity type", entityType), field("Relationship type", relationshipType), field("Starting entity", anchor), field("Knowledge graph", lens));
    root.replaceChildren(el("details", {}, el("summary", {}, "Saved explorations"), await explorations(graph)), controls, output);
    const updateLenses = () => {
      const selected = nodes.find((node) => node.id === anchor.value);
      lens.replaceChildren(el("option", { value: "" }, "Direct connections"), ...(selected ? knowledgeGraphsFor(graph, selected).map((item) => el("option", { value: item.node.id }, item.node.title)) : []));
      lens.disabled = !selected;
      lens.title = selected && lens.options.length === 1 ? "No saved knowledge graphs are available for this entity." : "";
    };
    const filteredView = () => {
      const selected = nodes.find((node) => node.id === anchor.value);
      const selectedLens = selected && lens.value ? knowledgeGraphsFor(graph, selected).find((item) => item.node.id === lens.value) : undefined;
      if (selectedLens && !selectedLens.definition) throw new Error(`This knowledge graph cannot be displayed: ${selectedLens.error}`);
      const neighborhoodEdges = selected ? edges.filter((edge) => edge.fromId === selected.id || edge.toId === selected.id) : edges;
      const neighborhoodIds = selected ? new Set([selected.id, ...neighborhoodEdges.flatMap((edge) => [edge.fromId, edge.toId])]) : nodeIds;
      const view = selected && selectedLens?.definition ? exploreKnowledgeGraph(graph, selected, selectedLens.definition) : { nodes: nodes.filter((node) => neighborhoodIds.has(node.id)), edges: neighborhoodEdges, truncated: false };
      const query = search.value.trim().toLowerCase();
      const visible = view.nodes.filter((node) => (!entityType.value || node.typeId === entityType.value) && (!query || node.title.toLowerCase().includes(query)));
      const ids = new Set(visible.map((node) => node.id));
      const links = view.edges.filter((edge) => ids.has(edge.fromId) && ids.has(edge.toId) && (!relationshipType.value || edge.typeId === relationshipType.value));
      return { selected, view, visible, ids, links };
    };
    const draw = () => {
      disposeKnowledgeGraphViewers(output);
      output.replaceChildren();
      let result: ReturnType<typeof filteredView>;
      try { result = filteredView(); } catch (error) { output.appendChild(el("p", { role: "alert" }, String(error))); return; }
      const { selected, view, visible, ids, links } = result;
      output.appendChild(el("p", { role: "status" }, `${visible.length} entities · ${links.length} relationships${view.truncated ? " · Knowledge graph limited to 200 entities" : ""}`));
      if (!visible.length) { output.appendChild(el("p", {}, "No entities match these filters.")); return; }
      if (visible.length > 200) { output.appendChild(el("p", {}, "Filter to 200 entities or fewer to display the graph.")); return; }
      output.appendChild(createKnowledgeGraphViewer(graph, { nodes: visible, edges: links }, selected && ids.has(selected.id) ? selected : visible[0], { initialScale: 0.85, nodeHref: entityUrl, onError: (error) => output.appendChild(el("p", { role: "alert" }, `Unable to arrange graph: ${String(error)}`)) }));
      output.appendChild(el("details", {}, el("summary", {}, "Entity and relationship list"), el("ul", {}, ...visible.map((node) => el("li", {}, el("a", { href: entityUrl(node.id) }, node.title)))), el("ul", {}, ...links.map((edge) => el("li", {}, `${nodes.find((n) => n.id === edge.fromId)?.title} → ${graph.types.find((t) => t.id === edge.typeId)?.title ?? "related"} → ${nodes.find((n) => n.id === edge.toId)?.title}`)))));
    };
    anchor.onchange = () => { updateLenses(); draw(); };
    for (const control of [entityType, relationshipType, lens]) control.onchange = draw;
    search.oninput = draw;
    updateLenses(); draw();
  } catch (error) { root.setAttribute("aria-busy", "false"); root.replaceChildren(el("p", { role: "alert" }, `Unable to load graph: ${String(error)}`)); }

}
document.addEventListener("astro:page-load", renderExplorer);
renderExplorer();

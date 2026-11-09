import { createKnowledgeGraphViewer, disposeKnowledgeGraphViewers } from "@ai-outfitter/ui/knowledge-graph";
import { exploreKnowledgeGraph, knowledgeGraphsFor } from "../lib/knowledge-graphs";
import { el, entityUrl, loadGraph } from "./data";

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
    root.replaceChildren(el("p", {}, "Choose a starting entity to explore its direct connections, then select an available knowledge graph to follow its saved traversal."), controls, output);
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
      output.appendChild(createKnowledgeGraphViewer(graph, { nodes: visible, edges: links }, selected && ids.has(selected.id) ? selected : visible[0], { nodeHref: entityUrl, onError: (error) => output.appendChild(el("p", { role: "alert" }, `Unable to arrange graph: ${String(error)}`)) }));
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

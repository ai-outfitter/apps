import type { Graph, GraphNode } from "../lib/graph";
import { el, link } from "./data";
import { readRelationships, relationshipQuery } from "../lib/ontology-relationships";
export function connections(graph: Graph, node: GraphNode) {
  const nodes = new Map(
    graph.nodes.filter((n) => !n.archived).map((n) => [n.id, n]),
  );
  const result = readRelationships(graph, relationshipQuery.parse({ nodeId: node.id, limit: 500 }));
  const records = new Map(graph.edges.map(edge => [edge.id, edge]));
  const edges = result.relationships.filter(edge => nodes.has(edge.fromId) && nodes.has(edge.toId));
  const list = el("ul", { class: "graph-relations" });
  for (const edge of edges)
    list.appendChild(
      el(
        "li",
        {},
        link(nodes.get(edge.fromId)!.title, edge.fromId),
        edge.symmetric ? " ↔ " : " → ",
        graph.types.find((t) => t.id === edge.typeId)?.title ?? "connected to",
        edge.symmetric ? " ↔ " : " → ",
        link(nodes.get(edge.toId)!.title, edge.toId),
        records.get(edge.source.id)?.properties.status ? ` · ${records.get(edge.source.id)?.properties.status}` : "",
        edge.derived ? " · derived from " : "",
        edge.derived ? link(nodes.get(edge.source.id)?.title ?? "relationship", edge.source.id) : null,
      ),
    );
  const section = el(
    "section",
    { class: "graph-section" },
    el("h2", {}, "Immediate connections"),
  );
  if (!edges.length) {
    section.appendChild(el("p", {}, "No connections yet."));
    return section;
  }
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 900 ${Math.max(150, edges.length * 90)}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Entity connections");
  const draw = (tag: string, attrs: Record<string, string>, label?: string) => {
    const element = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs))
      element.setAttribute(key, value);
    if (label) element.textContent = label;
    svg.appendChild(element);
    return element;
  };
  edges.forEach((edge, i) => {
    const y = 40 + i * 90;
    draw("line", {
      x1: "220",
      x2: "650",
      y1: String(y),
      y2: String(y),
      stroke: "currentColor",
    });
    draw(
      "text",
      { x: "235", y: String(y - 12) },
      `${edge.symmetric ? "↔" : edge.fromId === node.id ? "→" : "←"} ${graph.types.find((t) => t.id === edge.typeId)?.title ?? "connection"}`,
    );
    draw("rect", {
      x: "0",
      y: String(y - 22),
      width: "215",
      height: "44",
      rx: "8",
      class: "graph-node",
    });
    draw("text", { x: "12", y: String(y + 5) }, node.title);
    draw("rect", {
      x: "650",
      y: String(y - 22),
      width: "240",
      height: "44",
      rx: "8",
      class: "graph-node",
    });
    draw(
      "text",
      { x: "662", y: String(y + 5) },
      nodes.get(edge.fromId === node.id ? edge.toId : edge.fromId)!.title,
    );
  });
  section.appendChild(el("div", { class: "graph-viewport" }, svg));
  section.appendChild(list);
  if (result.nextOffset !== null) section.appendChild(el("p", {}, "Showing the first 500 connections."));
  return section;
}

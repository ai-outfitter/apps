import { createKnowledgeGraphViewer } from "@ai-outfitter/ui/knowledge-graph";
import { organizationChart } from "../lib/org-chart";
import type { Graph, GraphNode } from "../lib/graph";
import { el, entityUrl, link } from "./data";

export function orgChartLinks(graph: Graph, anchor: GraphNode, href: string): string[][] {
  const name = graph.types.find(type => type.id === anchor.typeId)?.name;
  return ["Organization", "Board"].includes(name ?? "") ? [["Org chart", `${href}/org-chart`, "org-chart"]] : [];
}
export function orgChartView(graph: Graph, anchor: GraphNode) {
  if (!orgChartLinks(graph, anchor, "").length) return el("p", {}, "Org charts start from an organization or board.");
  const view = organizationChart(graph, anchor);
  const section = el("section", { class: "wiki-map org-chart" }, el("h2", {}, "Organization chart"),
    el("p", {}, "Board membership, assigned roles and recorded reporting lines. Grouping shows scope; it does not establish reporting authority."));
  if (!view.positions.length) {
    section.appendChild(el("p", {}, "No role assignments are recorded for this organization or board yet."));
    return section;
  }
  section.appendChild(el("p", { role: "status" }, `${view.positions.length} role assignments · ${view.reportingLines} recorded reporting lines`));
  if (!view.reportingLines) section.appendChild(el("p", {}, "Reporting lines have not been recorded. Positions are grouped by their organization or board."));
  if (view.unresolvedReports) section.appendChild(el("p", {}, `${view.unresolvedReports} reporting relationships are ambiguous or cyclic and cannot be shown as a hierarchy.`));
  section.appendChild(createKnowledgeGraphViewer(view.chart, view.chart, view.root, {
    direction: "DOWN", initialScale: 1, nodeHref: id => entityUrl(view.nodeId(id)),
    onError: error => section.appendChild(el("p", { role: "alert" }, `Unable to arrange the organization chart: ${String(error)}`)),
  }));
  section.appendChild(el("details", {}, el("summary", {}, "Role assignments"), el("ul", {},
    ...view.positions.map(({ assignment, roles, holders }) => el("li", {}, link(assignment.title, assignment.id),
      roles.length ? el("span", {}, " · ", ...roles.map(id => link(graph.nodes.find(node => node.id === id)!.title, id))) : null,
      holders.length ? el("span", {}, " · ", ...holders.map(id => link(graph.nodes.find(node => node.id === id)!.title, id))) : null)))));
  return section;
}

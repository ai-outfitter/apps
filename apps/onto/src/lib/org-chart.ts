import type { KnowledgeGraphData } from "@ai-outfitter/ui/knowledge-graph";
import type { Graph, GraphNode } from "./graph";

function sourceData(graph: Graph) {
  const nodes = new Map(graph.nodes.filter(node => !node.archived).map(node => [node.id, node]));
  const types = new Map(graph.types.filter(type => !type.archived).map(type => [type.id, type.name]));
  const edges = graph.edges.filter(edge => !edge.archived && types.has(edge.typeId) && nodes.has(edge.fromId) && nodes.has(edge.toId));
  const named = (id: string, name: string) => types.get(nodes.get(id)?.typeId ?? "") === name;
  const targets = (id: string, type: string) => edges.filter(edge => edge.fromId === id && types.get(edge.typeId) === type).map(edge => edge.toId);
  return { nodes, types, edges, named, targets };
}
type Source = ReturnType<typeof sourceData>;
function scopedIds(source: Source, root: GraphNode) {
  const scopes = new Set([root.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of source.edges) {
      if (source.types.get(edge.typeId) !== "part_of" || !scopes.has(edge.toId) || scopes.has(edge.fromId)) continue;
      if (!source.named(edge.fromId, "Board") && !source.named(edge.fromId, "BusinessUnit")) continue;
      scopes.add(edge.fromId); changed = true;
    }
  }
  return scopes;
}
function scopedPositions(source: Source, scopes: Set<string>) {
  return [...source.nodes.values()].filter(node => source.named(node.id, "RoleAssignment"))
    .flatMap(assignment => {
      const scope = source.targets(assignment.id, "scoped_to").find(id => scopes.has(id));
      if (!scope) return [];
      const roles = source.targets(assignment.id, "assigns_role").filter(id => source.named(id, "Role"));
      const holders = source.targets(assignment.id, "assigned_to").filter(id => source.named(id, "Person") || source.named(id, "Agent"));
      return [{ assignment, roles, holders, scope }];
    });
}
type Position = ReturnType<typeof scopedPositions>[number];
function displayTitle(source: Source, position: Position) {
  const titles = (ids: string[]) => ids.map(id => source.nodes.get(id)?.title).join(" / ");
  return `${titles(position.roles) || "Role not recorded"} — ${titles(position.holders) || "Holder not recorded"}`;
}
function addEdge(chart: KnowledgeGraphData, fromId: string, toId: string, typeId = "chart-membership") {
  const id = `${typeId}:${fromId}:${toId}`;
  if (!chart.edges.some(edge => edge.id === id)) chart.edges.push({ id, fromId, toId, typeId, properties: {} });
}
function addScopes(chart: KnowledgeGraphData, source: Source, scopes: Set<string>, root: GraphNode) {
  for (const id of scopes) {
    if (id === root.id) continue;
    const node = source.nodes.get(id);
    if (!node) continue;
    chart.nodes.push({ id, typeId: source.named(id, "Board") ? "chart-board" : "chart-team", title: node.title });
    for (const parent of source.targets(id, "part_of").filter(parent => scopes.has(parent))) addEdge(chart, parent, id);
  }
}
function wouldCycle(chart: KnowledgeGraphData, parent: string, child: string) {
  const pending = [child], seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === parent) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...chart.edges.filter(edge => edge.fromId === id).map(edge => edge.toId));
  }
  return false;
}
function addReports(chart: KnowledgeGraphData, source: Source, positions: Position[]) {
  const resolve = (id: string) => positions.filter(item => item.assignment.id === id || item.roles.includes(id) || item.holders.includes(id));
  const managed = new Set<string>();
  let unresolvedReports = 0;
  for (const edge of source.edges.filter(edge => source.types.get(edge.typeId) === "reports_to")) {
    const child = resolve(edge.fromId), parent = resolve(edge.toId);
    if (!child.length || !parent.length) continue;
    if (child.length !== 1 || parent.length !== 1 || wouldCycle(chart, parent[0].assignment.id, child[0].assignment.id)) { unresolvedReports++; continue; }
    addEdge(chart, parent[0].assignment.id, child[0].assignment.id, edge.properties.status === "proposed" ? "chart-proposed-report" : "chart-report");
    managed.add(child[0].assignment.id);
  }
  return { managed, unresolvedReports };
}

/** A display projection of scoped assignments. Grouping edges are not stored reporting facts. */
export function organizationChart(graph: Graph, anchor: GraphNode) {
  const source = sourceData(graph);
  const parents = source.targets(anchor.id, "part_of").filter(id => source.named(id, "Organization"));
  const organization = source.named(anchor.id, "Organization") ? anchor : parents.length === 1 ? source.nodes.get(parents[0]) : undefined;
  const root = organization ?? anchor;
  const scopes = scopedIds(source, root);
  const positions = scopedPositions(source, scopes);
  const chart: KnowledgeGraphData = {
    types: [
      { id: "chart-scope", name: "membership", title: "Organization" },
      { id: "chart-board", name: "board", title: "Board" },
      { id: "chart-team", name: "team", title: "Team" },
      { id: "chart-position", name: "position", title: "Role assignment" },
      { id: "chart-membership", name: "includes", title: "Includes" },
      { id: "chart-report", name: "direct reports", title: "Direct reports" },
      { id: "chart-proposed-report", name: "proposed direct reports", title: "Proposed direct reports" },
    ],
    nodes: [{ id: root.id, typeId: source.named(root.id, "Board") ? "chart-board" : "chart-scope", title: root.title }], edges: [],
  };
  addScopes(chart, source, scopes, root);
  chart.nodes.push(...positions.map(position => ({ id: position.assignment.id, typeId: "chart-position", title: displayTitle(source, position) })));
  const { managed, unresolvedReports } = addReports(chart, source, positions);
  const team = `org-chart-team:${root.id}`;
  if (organization && positions.some(item => item.scope === organization.id)) {
    chart.nodes.push({ id: team, typeId: "chart-team", title: "Executive team & organization roles" });
    addEdge(chart, organization.id, team);
  }
  for (const item of positions.filter(item => !managed.has(item.assignment.id)))
    addEdge(chart, organization && item.scope === organization.id ? team : item.scope, item.assignment.id);
  return { chart, root: chart.nodes[0], positions, unresolvedReports,
    reportingLines: chart.edges.filter(edge => ["chart-report", "chart-proposed-report"].includes(edge.typeId)).length,
    nodeId: (id: string) => id === team ? root.id : id };
}

import { readFileSync } from "node:fs";
import { core, type Graph, type GraphNode } from "../../src/lib/graph";
export const chartId = (n: number) => `78000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function chartFixture() {
  const stamp = { revision: 1, createdBy: null, updatedBy: null, createdAt: 0, updatedAt: 0, archived: false };
  const organization: GraphNode = { ...stamp, id: chartId(0), typeId: core.organization, title: "Example organization", slug: "example", summary: "", body: "", properties: {}, website: null, source: null };
  const graph: Graph = { canEdit: false, home: { organizationId: organization.id }, nodes: [organization], edges: [],
    types: JSON.parse(readFileSync(new URL("../../seeds/types-v1.json", import.meta.url), "utf8")).map((type: object) => ({ ...stamp, seedVersion: 1, ...type })) };
  if (!graph.types.some(type => type.name === "Board")) graph.types.push({ ...graph.types[0], id: chartId(200), name: "Board", title: "Boards", category: "node", properties: [] });
  const type = (name: string) => graph.types.find(type => type.name === name)!.id;
  const node = (n: number, name: string, title: string): GraphNode => ({ ...organization, id: chartId(n), typeId: type(name), title, slug: `chart-${n}`, body: "", summary: "", properties: {} });
  graph.nodes.push(node(1, "Board", "Board of directors"), node(2, "RoleAssignment", "Director assignment"), node(3, "RoleAssignment", "CEO assignment"), node(4, "RoleAssignment", "Engineer assignment"), node(5, "Person", "Board member"), node(6, "Person", "Executive lead"), node(7, "Person", "Engineering lead"), node(8, "Role", "Director"), node(9, "Role", "Chief Executive Officer"), node(10, "Role", "Engineer"));
  const edge = (n: number, name: string, from: string, to: string) => ({ ...stamp, id: chartId(n), typeId: type(name), fromId: from, toId: to, title: "", body: "", properties: {} as Record<string, string | number | boolean | null>, archived: false });
  graph.edges.push(edge(101, "part_of", chartId(1), organization.id));
  for (const [i, scope, role, holder] of [[2,chartId(1),8,5],[3,organization.id,9,6],[4,organization.id,10,7]] as const) graph.edges.push(edge(110+i,"scoped_to",chartId(i),scope),edge(120+i,"assigns_role",chartId(i),chartId(role)),edge(130+i,"assigned_to",chartId(i),chartId(holder)));
  graph.edges.push(edge(150,"reports_to",chartId(4),chartId(3)));
  return { graph, organization, board: graph.nodes.find(node => node.id === chartId(1))!, type, edge };
}

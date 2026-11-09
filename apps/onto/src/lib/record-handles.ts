import type { Graph } from "./graph";

// Agents name records by handle instead of UUID: a type by its name, a node by its
// slug and an edge by `<type name>:<from slug>:<to slug>`. Handles are short, stable
// across reads and cache well in prompts. Storage keeps UUIDs; handles resolve on
// every write against the graph the write validates.

export type RecordKind = "graph-type" | "graph-node" | "graph-edge";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => uuid.test(value);

export const edgeHandle = (type: string, from: string, to: string) => `${type}:${from}:${to}`;

type Index = Record<RecordKind, Map<string, string | null>>;

/** Handle → id for every record; `null` marks a handle two active edges share. */
export function handleIndex(graph: Pick<Graph, "types" | "nodes" | "edges">): Index {
  const types = new Map(graph.types.map((type) => [type.id, type.name]));
  const slugs = new Map(graph.nodes.map((node) => [node.id, node.slug ?? node.id]));
  const edges = new Map<string, string | null>();
  for (const edge of graph.edges) {
    if (edge.archived) continue;
    const handle = edgeHandle(types.get(edge.typeId) ?? edge.typeId, slugs.get(edge.fromId) ?? edge.fromId, slugs.get(edge.toId) ?? edge.toId);
    edges.set(handle, edges.has(handle) ? null : edge.id);
  }
  return {
    "graph-type": new Map(graph.types.map((type) => [type.name, type.id])),
    "graph-node": new Map(graph.nodes.flatMap((node) => (node.slug ? [[node.slug, node.id] as const] : []))),
    "graph-edge": edges,
  };
}

const labels: Record<RecordKind, string> = {
  "graph-type": "type name",
  "graph-node": "node slug",
  "graph-edge": "edge (type:from:to)",
};

/** The record id a UUID or handle names; throws a 400 naming the handle otherwise. */
export function resolveHandle(index: Index, kind: RecordKind, value: string) {
  if (isUuid(value)) return value.toLowerCase();
  const id = index[kind].get(value);
  if (id === null) throw new Response(`Ambiguous ${labels[kind]} ${value}; several active records match`, { status: 400 });
  if (id === undefined) throw new Response(`Unknown ${labels[kind]} ${value}`, { status: 400 });
  return id;
}

/** id → handle, for answers agents read back. */
export function recordHandle(graph: Pick<Graph, "types" | "nodes" | "edges">) {
  const types = new Map(graph.types.map((type) => [type.id, type.name]));
  const slugs = new Map(graph.nodes.map((node) => [node.id, node.slug ?? node.id]));
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  return (kind: RecordKind, id: string) => {
    if (kind === "graph-type") return types.get(id) ?? null;
    if (kind === "graph-node") return slugs.get(id) ?? null;
    const edge = edges.get(id);
    return edge ? edgeHandle(types.get(edge.typeId) ?? edge.typeId, slugs.get(edge.fromId) ?? edge.fromId, slugs.get(edge.toId) ?? edge.toId) : null;
  };
}

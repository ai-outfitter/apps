import type { Graph } from "./graph";

// Agents name records by address, never by UUID: a type by its name (`Person`), a node
// by type and slug (`Organization:sunny`) and an edge by its type and ends
// (`works_on(Person:ada → Project:sunny)`, with `@<validFrom>` when it has a start).
// Addresses are short, stable across reads and cache well in prompts. Storage keeps
// UUIDs; addresses resolve on every write against the graph the write validates.

export type RecordKind = "graph-type" | "graph-node" | "graph-edge";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => uuid.test(value);

export const nodeAddress = (type: string, slug: string) => `${type}:${slug}`;
/** A start at midnight UTC reads as its date. */
const start = (validFrom: string | null | undefined) =>
  validFrom ? `@${validFrom.replace(/T00:00(:00(\.000)?)?(Z|\+00:00)$/, "")}` : "";
export const edgeAddress = (type: string, from: string, to: string, validFrom?: string | null) =>
  `${type}(${from} → ${to})${start(validFrom)}`;
const edgePattern = /^([^()\s]+)\(\s*(\S+)\s*(?:→|->)\s*(\S+)\s*\)(@\S+)?$/;

type Index = Record<RecordKind, Map<string, string>>;
type Records = Pick<Graph, "types" | "nodes" | "edges">;

function namer(graph: Records) {
  const types = new Map(graph.types.map((type) => [type.id, type.name]));
  const nodes = new Map(graph.nodes.map((node) => [node.id, nodeAddress(types.get(node.typeId) ?? node.typeId, node.slug ?? node.id)]));
  const edge = (row: Records["edges"][number]) =>
    edgeAddress(types.get(row.typeId) ?? row.typeId, nodes.get(row.fromId) ?? row.fromId, nodes.get(row.toId) ?? row.toId, row.validity?.from);
  return { types, nodes, edge };
}

/** Address → id for every type, node and active edge. Each address names one record. */
export function addressIndex(graph: Records): Index {
  const { types, nodes, edge } = namer(graph);
  return {
    "graph-type": new Map([...types].map(([id, name]) => [name, id])),
    "graph-node": new Map([...nodes].map(([id, address]) => [address, id])),
    "graph-edge": new Map(graph.edges.filter((row) => !row.archived).map((row) => [edge(row), row.id])),
  };
}

const labels: Record<RecordKind, string> = {
  "graph-type": "type name, such as Person",
  "graph-node": "node address, such as Organization:sunny",
  "graph-edge": "edge address, such as works_on(Person:ada → Project:sunny)",
};

/** The record id a UUID or address names; throws a 400 naming the address otherwise. */
export function resolveAddress(index: Index, kind: RecordKind, value: string) {
  if (isUuid(value)) return value.toLowerCase();
  const edge = kind === "graph-edge" ? edgePattern.exec(value) : null;
  const key = edge ? edgeAddress(edge[1], edge[2], edge[3], edge[4]?.slice(1)) : value;
  const id = index[kind].get(key);
  if (id === undefined) throw new Response(`Unknown ${labels[kind]}: ${value}`, { status: 400 });
  return id;
}

/** id → address, for answers agents read back. */
export function recordAddress(graph: Records) {
  const { types, nodes, edge } = namer(graph);
  const edges = new Map(graph.edges.map((row) => [row.id, row]));
  return (kind: RecordKind, id: string) => {
    if (kind === "graph-type") return types.get(id) ?? null;
    if (kind === "graph-node") return nodes.get(id) ?? null;
    const row = edges.get(id);
    return row ? edge(row) : null;
  };
}

import { addressIndex } from "../lib/addresses";
import type { Graph } from "../lib/graph";

type Row = { ref: string; state: string; operation: { type: string; id?: string; attributes: Record<string, unknown> } };

/** Facts the reviewer can check mechanically, even when its displayed neighborhood is clipped. */
export function reviewGraphContext(graph: Graph, rows: Row[], root: string | null) {
  const index = addressIndex(graph);
  const ids = new Map(rows.map(row => [row.ref, String(row.operation.id ?? row.operation.attributes.id ?? row.ref)]));
  const resolve = (kind: keyof typeof index, raw: unknown) => {
    const id = ids.get(String(raw)) ?? String(raw);
    return index[kind].get(id) ?? id;
  };
  const nodes = new Map(graph.nodes.map(n => [n.id, { type: n.typeId, archived: n.archived }]));
  const edges = new Map(graph.edges.map(e => [e.id, { type: e.typeId, from: e.fromId, to: e.toId, archived: e.archived }]));
  const types = new Map(graph.types.filter(t => !t.archived).map(t => [t.id, t]));
  for (const row of rows.filter(row => !["removed","rejected"].includes(row.state))) {
    const attrs = row.operation.attributes;
    if (row.operation.type === "graph-node") {
      const id = resolve("graph-node", row.ref), before = nodes.get(id);
      nodes.set(id, { type: attrs.typeId === undefined ? before?.type ?? "" : resolve("graph-type", attrs.typeId),
        archived: attrs.archived === undefined ? before?.archived ?? false : attrs.archived === true });
    } else if (row.operation.type === "graph-edge") {
      const id = resolve("graph-edge", row.ref), before = edges.get(id);
      edges.set(id, { type: attrs.typeId === undefined ? before?.type ?? "" : resolve("graph-type", attrs.typeId),
        from: attrs.fromId === undefined ? before?.from ?? "" : resolve("graph-node", attrs.fromId),
        to: attrs.toId === undefined ? before?.to ?? "" : resolve("graph-node", attrs.toId),
        archived: attrs.archived === undefined ? before?.archived ?? false : attrs.archived === true });
    }
  }
  const neighbors = new Map<string, string[]>();
  const link = (a: string, b: string) => { const list = neighbors.get(a) ?? []; list.push(b); neighbors.set(a, list); };
  for (const edge of edges.values()) {
    if (edge.archived || !nodes.has(edge.from) || !nodes.has(edge.to) || nodes.get(edge.from)?.archived || nodes.get(edge.to)?.archived) continue;
    link(edge.from, edge.to); link(edge.to, edge.from);
  }
  const reachable = new Set<string>(), queue = root && !nodes.get(root)?.archived ? [root] : [];
  while (queue.length) {
    const id = queue.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const other of neighbors.get(id) ?? []) if (!reachable.has(other)) queue.push(other);
  }
  return (row: Row) => {
    const key = row.operation.id ?? row.operation.attributes.id ?? row.ref;
    const edge = row.operation.type === "graph-edge" ? edges.get(resolve("graph-edge", key)) : undefined;
    if (!edge) return { reachableFromOwner: root && row.operation.type === "graph-node" ? reachable.has(resolve("graph-node", key)) : null };
    const relationship = types.get(edge.type), endpoints = relationship?.ontology?.endpoints;
    const fromType = nodes.get(edge.from)?.type, toType = nodes.get(edge.to)?.type;
    const accepts = (side: string[] | "any", value: string) => side === "any" || side.includes(value);
    return { reachableFromOwner: root ? reachable.has(edge.from) && reachable.has(edge.to) : null,
      typeId: edge.type, predicate: relationship?.name, fromType, toType, endpoints,
      endpointsAllowed: endpoints && fromType && toType ? accepts(endpoints.from, fromType) && accepts(endpoints.to, toType) : null };
  };
}

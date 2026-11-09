import { ontologyContract, type OntologyContract, type OntologyV2, type ValidityInterval } from "@ai-outfitter/onto/contracts";
import type { GraphEdge, GraphNode, TypeDefinition } from "./graph";

export type OntologyType = Pick<
  TypeDefinition,
  "id" | "category" | "ontology"
> &
  Partial<Pick<TypeDefinition, "archived" | "jsonSchema" | "name" | "properties">>;
export type OntologyNode = Pick<GraphNode, "id" | "typeId" | "archived"> &
  Partial<Pick<GraphNode, "body" | "validity" | "revision">>;
export type OntologyEdge = Pick<
  GraphEdge,
  "id" | "typeId" | "fromId" | "toId" | "archived"
> &
  Partial<Pick<GraphEdge, "validity" | "revision">>;
export type OntologyGraph = {
  types: OntologyType[];
  nodes: OntologyNode[];
  edges: OntologyEdge[];
};
import type { OntologyViolation } from "./ontology-errors";
export type { OntologyViolation } from "./ontology-errors";
export function ontologyContext(graph: OntologyGraph) {
  const outgoing = new Map<string, OntologyEdge[]>();
  for (const edge of graph.edges) {
    const edges = outgoing.get(edge.fromId) ?? [];
    edges.push(edge);
    outgoing.set(edge.fromId, edges);
  }
  const contracts = new Map<string, OntologyContract>();
  for (const type of graph.types) {
    const parsed = ontologyContract.safeParse(type.ontology);
    if (parsed.success) contracts.set(type.id, parsed.data);
  }
  return {
    graph,
    outgoing,
    types: new Map(graph.types.map((t) => [t.id, t])),
    nodes: new Map(graph.nodes.map((n) => [n.id, n])),
    edges: new Map(graph.edges.map((e) => [e.id, e])),
    contracts,
  };
}
export type OntologyContext = ReturnType<typeof ontologyContext>;
export const v2 = (contract?: OntologyContract): OntologyV2 | undefined =>
  contract?.version === 2 ? contract : undefined;
export const intervalBounds = (
  interval?: ValidityInterval | null,
): [number, number] => [
  interval?.from ? Date.parse(interval.from) : -Infinity,
  interval?.to ? Date.parse(interval.to) : Infinity,
];
export function intervalsOverlap(
  a?: ValidityInterval | null,
  b?: ValidityInterval | null,
) {
  const [a0, a1] = intervalBounds(a),
    [b0, b1] = intervalBounds(b);
  return a0 < b1 && b0 < a1;
}
export function validAt(
  interval: ValidityInterval | null | undefined,
  at: number,
) {
  const [from, to] = intervalBounds(interval);
  return from <= at && at < to;
}
export const unorderedPair = (a: string, b: string) =>
  a < b ? ([a, b] as const) : ([b, a] as const);
export const violation = (
  recordId: string,
  rule: string,
  path: string,
  message: string,
  relatedRecordIds?: string[],
): OntologyViolation => ({
  recordId,
  rule,
  path,
  message,
  ...(relatedRecordIds?.length ? { relatedRecordIds } : {}),
});

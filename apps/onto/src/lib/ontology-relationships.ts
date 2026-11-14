import { z } from "zod";
import { validityInterval } from "@ai-outfitter/app-sdk/graph-contracts";
import {
  type OntologyGraph,
  type OntologyContext,
  type OntologyNode,
  type OntologyEdge,
  type OntologyType,
  ontologyContext,
  v2,
  unorderedPair,
  validAt,
} from "./ontology-model";
import { auditContext } from "./ontology-validation";
import { auditRelator, participationEdges } from "./ontology-records";

export const relationshipQuery = z.strictObject({
  typeId: z.uuid().optional(),
  nodeId: z.uuid().optional(),
  fromId: z.uuid().optional(),
  toId: z.uuid().optional(),
  at: z.iso.datetime({ offset: true }).nullable().optional(),
  includeArchived: z.boolean().default(false),
  offset: z.number().int().nonnegative().max(100000).default(0),
  limit: z.number().int().min(1).max(500).default(100),
});
export const relationshipView = z.strictObject({
  id: z.string(),
  typeId: z.uuid(),
  fromId: z.uuid(),
  toId: z.uuid(),
  symmetric: z.boolean(),
  derived: z.boolean(),
  validity: validityInterval.nullable(),
  archived: z.boolean(),
  source: z.strictObject({
    kind: z.enum(["edge", "relator"]),
    id: z.uuid(),
    revision: z.number().int().positive(),
  }),
});
export const relationshipResults = z.strictObject({
  relationships: z.array(relationshipView).max(500),
  total: z.number().int(),
  nextOffset: z.number().int().nullable(),
});
type View = z.infer<typeof relationshipView>;
type Query = z.infer<typeof relationshipQuery>;
function visible(
  row: OntologyNode | OntologyEdge,
  query: Query,
  at: number | null,
) {
  return (
    (query.includeArchived || !row.archived) &&
    (at === null || validAt(row.validity, at))
  );
}
function participantVisible(
  id: string,
  ctx: OntologyContext,
  query: Query,
  at: number | null,
) {
  const node = ctx.nodes.get(id);
  return !!node && visible(node, query, at);
}
function directViews(
  ctx: OntologyContext,
  query: Query,
  at: number | null,
): View[] {
  return ctx.graph.edges
    .filter(
      (edge) =>
        !v2(ctx.contracts.get(edge.typeId))?.projection &&
        (query.includeArchived || !ctx.types.get(edge.typeId)?.archived) &&
        visible(edge, query, at) &&
        participantVisible(edge.fromId, ctx, query, at) &&
        participantVisible(edge.toId, ctx, query, at),
    )
    .map((edge) => ({
      id: edge.id,
      typeId: edge.typeId,
      fromId: edge.fromId,
      toId: edge.toId,
      symmetric: v2(ctx.contracts.get(edge.typeId))?.symmetric ?? false,
      derived: false,
      validity: edge.validity ?? null,
      archived: edge.archived,
      source: { kind: "edge", id: edge.id, revision: edge.revision ?? 1 },
    }));
}
function derivedFrom(
  node: OntologyNode,
  type: OntologyType,
  ctx: OntologyContext,
  query: Query,
  at: number | null,
): View[] {
  const projection = v2(ctx.contracts.get(type.id))?.projection;
  if (
    !projection ||
    node.typeId !== projection.relatorTypeId ||
    !visible(node, query, at)
  )
    return [];
  const contract = v2(ctx.contracts.get(node.typeId));
  if (
    !contract?.participation ||
    auditRelator({ ...node, archived: false }, contract, ctx).length
  )
    return [];
  const fromSlot = contract.participation.slots.find(
      (s) => s.name === projection.fromSlot,
    ),
    toSlot = contract.participation.slots.find(
      (s) => s.name === projection.toSlot,
    );
  if (!fromSlot || !toSlot) return [];
  const from = participationEdges(node, fromSlot, ctx).filter((e) =>
      participantVisible(e.toId, ctx, query, at),
    ),
    to = participationEdges(node, toSlot, ctx).filter((e) =>
      participantVisible(e.toId, ctx, query, at),
    );
  return participantPairs(node, type.id, projection.symmetric, from, to);
}
function participantPairs(
  node: OntologyNode,
  typeId: string,
  symmetric: boolean,
  from: OntologyEdge[],
  to: OntologyEdge[],
): View[] {
  const rows = new Map<string, View>();
  for (const left of from) {
    for (const right of to) {
      if (left.toId === right.toId) continue;
      const pair = symmetric
        ? unorderedPair(left.toId, right.toId)
        : [left.toId, right.toId];
      const id = [typeId, node.id, ...pair].join(":");
      rows.set(id, {
        id,
        typeId: typeId,
        fromId: pair[0],
        toId: pair[1],
        symmetric: symmetric,
        derived: true,
        validity: node.validity ?? null,
        archived: node.archived,
        source: { kind: "relator", id: node.id, revision: node.revision ?? 1 },
      });
    }
  }
  return [...rows.values()];
}
function orient(row: View, query: Query): View {
  if (!row.symmetric) return row;
  let [fromId, toId] = unorderedPair(row.fromId, row.toId);
  if (
    (query.fromId && query.fromId === toId) ||
    (query.toId && query.toId === fromId)
  )
    [fromId, toId] = [toId, fromId];
  return { ...row, fromId, toId };
}
function matches(row: View, query: Query) {
  return (
    (!query.typeId || row.typeId === query.typeId) &&
    (!query.nodeId ||
      row.fromId === query.nodeId ||
      row.toId === query.nodeId) &&
    (!query.fromId || row.fromId === query.fromId) &&
    (!query.toId || row.toId === query.toId)
  );
}
/** One row per direct edge or derived participant pair. No duplicated editable facts. */
export function readRelationships(
  graph: OntologyGraph,
  query: Query,
  now = Date.now(),
): z.infer<typeof relationshipResults> {
  const ctx = ontologyContext(graph);
  const archivedRelators = new Set(graph.nodes.filter((node) =>
    node.archived && v2(ctx.contracts.get(node.typeId))?.stereotype === "relator",
  ).map((node) => node.id));
  const history = query.includeArchived
    ? ontologyContext({
        ...graph,
        nodes: graph.nodes.map((n) => ({ ...n, archived: false })),
        edges: graph.edges.map((e) => ({ ...e, archived: e.archived && !archivedRelators.has(e.fromId) })),
      })
    : ctx;
  const at = query.at === null ? null : query.at ? Date.parse(query.at) : now;
  const invalid = new Set(auditContext(ctx).map((e) => e.recordId));
  const derived = graph.types
    .filter(
      (type) =>
        (query.includeArchived || !type.archived) &&
        v2(ctx.contracts.get(type.id))?.projection &&
        !invalid.has(type.id),
    )
    .flatMap((type) => {
      const relatorTypeId = v2(ctx.contracts.get(type.id))?.projection?.relatorTypeId;
      return graph.nodes
        .filter((node) => node.typeId === relatorTypeId && !invalid.has(node.id) && !invalid.has(node.typeId))
        .flatMap((node) => derivedFrom(node, type, history, query, at));
    });
  const rows = [...directViews(ctx, query, at), ...derived]
    .map((row) => orient(row, query))
    .filter((row) => matches(row, query))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    relationships: rows.slice(query.offset, query.offset + query.limit),
    total: rows.length,
    nextOffset:
      query.offset + query.limit < rows.length
        ? query.offset + query.limit
        : null,
  };
}

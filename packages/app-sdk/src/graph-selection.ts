// Knowledge graphs are filtered views of the Wiki graph: a root node, the
// relationships to follow (with directions and endpoint types) and a depth and
// node budget. Wiki selects them for `knowledge-graph.render`, which apps call
// through the workflow host (`renderKnowledgeGraph`).
// `selectGraph` adapts these records to the same engine as Wiki saved lenses;
// retrieval can later move into SQL without changing callers.
// Fetching is separate from rendering: `renderGraphMarkdown` is the standard
// factual rendering, and each app may template the same selection differently.
// Authorization stays with Wiki's dispatch; a selection grants nothing.
import { z } from "zod";
import { type EntityRecord, type EntityRef, entityRecord, entityRef } from "./entities";
import { exploreKnowledgeGraph, isRetired, resolveKnowledgeGraph } from "./knowledge-graph";

const typeName = z.string().trim().min(1).max(120);
export const graphSelectionRule = z.union([
  typeName,
  z.strictObject({
    type: typeName,
    direction: z.enum(["outgoing", "incoming"]).default("outgoing"),
    from_type: typeName.optional(),
    to_type: typeName.optional(),
  }),
]);
/** A versioned selection: what a Wiki `KnowledgeGraph` record's `root_type` and
 * `pattern` hold, with explicit identity and a node budget. */
export const graphSelectionDefinition = z.strictObject({
  id: z.string().min(1).max(120),
  version: z.number().int().positive(),
  purpose: z.string().max(2000).default(""),
  rootTypes: z.array(typeName).min(1).max(32),
  relationships: z.array(graphSelectionRule).min(1).max(32),
  maxDepth: z.number().int().min(1).max(10),
  maxNodes: z.number().int().min(1).max(500),
  /** Node types the traversal never expands from (still selected as leaves). */
  terminalTypes: z.array(typeName).max(64).default([]),
  /** Node types the traversal does not expand once reached; unlike terminal types, a root of this type still expands. */
  stopAtTypes: z.array(typeName).max(32).default([]),
  /** Reached types that expand one more step; what they reach is shown, not expanded. */
  stopAfterTypes: z.array(typeName).max(32).default([]),
  /** When given, only nodes of these types are reached (roots always are); a node of another
   * type is neither selected nor expanded through, as if its edges were not followed. */
  nodeTypes: z.array(typeName).max(64).optional(),
});
export type GraphSelectionDefinition = z.infer<typeof graphSelectionDefinition>;
export type GraphSelectionRule = { type: string; direction: "outgoing" | "incoming"; from_type?: string; to_type?: string };

export type SelectableGraph = { types: EntityRecord[]; nodes: EntityRecord[]; edges: EntityRecord[] };
export type GraphSelection = {
  definition: GraphSelectionDefinition;
  roots: EntityRecord[];
  nodes: EntityRecord[];
  /** Edges with both endpoints selected, plus edges from a selected node to an
   * omitted or unresolved one (so the document can say what was left out). */
  edges: EntityRecord[];
  /** Distance from the nearest root, by node ID. */
  depth: Map<string, number>;
  /** Reachable nodes left out because of `maxNodes` or `maxDepth`. */
  omitted: EntityRef[];
  /** Edge endpoints that do not exist (or are archived) in the graph. */
  unresolved: EntityRef[];
  /** Whether a bound, not the data, stopped the traversal. */
  incomplete: boolean;
  missingTypes: string[];
  typeName(record: EntityRecord): string;
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a: EntityRecord, b: EntityRecord) => compare(a.ref.id, b.ref.id);
const active = (record: EntityRecord) => !record.attributes.archived && !record.attributes.archivedAt;
/** Shared with Wiki lenses and in-memory selection. */
export const retired = (record: EntityRecord) => isRetired(record.attributes);

export const normalizeRule = (rule: z.infer<typeof graphSelectionRule>): GraphSelectionRule =>
  typeof rule === "string" ? { type: rule, direction: "outgoing" } : rule;

/** Read a Wiki `KnowledgeGraph` record (`root_type` and JSON `pattern`) as a definition. */
export function definitionFromKnowledgeGraph(record: EntityRecord, bounds: { id: string; version: number; maxNodes: number; terminalTypes?: string[] }): GraphSelectionDefinition {
  const properties = (record.attributes.properties ?? {}) as Record<string, unknown>;
  const pattern = z.strictObject({ relationships: z.array(graphSelectionRule).min(1).max(32), max_depth: z.number().int().min(1).max(10) })
    .parse(JSON.parse(String(properties.pattern ?? "")));
  return graphSelectionDefinition.parse({
    id: bounds.id, version: bounds.version, purpose: String(record.attributes.summary ?? ""),
    rootTypes: [String(properties.root_type ?? "")], relationships: pattern.relationships, maxDepth: pattern.max_depth,
    maxNodes: bounds.maxNodes, terminalTypes: bounds.terminalTypes ?? [],
  });
}

type SelectionNode = { id: string; typeId: string; record: EntityRecord };
type SelectionEdge = SelectionNode & { fromId: string; toId: string };
type ResolvedPattern = ReturnType<typeof resolveKnowledgeGraph>;

function prepareRecords(graph: SelectableGraph) {
  const types = graph.types.map(record => ({ id: record.ref.id, name: String(record.attributes.name), category: record.attributes.category as "node" | "edge", archived: !active(record) }));
  const hidden = new Set(graph.nodes.filter(record => !active(record) || retired(record)).map(record => record.ref.id));
  const nodes = graph.nodes.filter(record => !hidden.has(record.ref.id)).map(record => ({ id: record.ref.id, typeId: String(record.attributes.typeId), record }));
  const visibleEdge = (record: EntityRecord) => active(record) && !retired(record) && !hidden.has(String(record.attributes.fromId)) && !hidden.has(String(record.attributes.toId));
  const edges = graph.edges.filter(visibleEdge)
    .map(record => ({ id: record.ref.id, typeId: String(record.attributes.typeId), fromId: String(record.attributes.fromId), toId: String(record.attributes.toId), record }));
  return { types, nodes, edges };
}

function selectionRoots(nodes: SelectionNode[], rootIds: readonly string[], pattern: ResolvedPattern) {
  const rootSet = new Set(rootIds);
  const roots = nodes.filter(node => rootSet.has(node.id) && pattern.rootTypes.includes(node.typeId)).sort((a,b) => compare(a.id,b.id));
  if (roots.length && roots.length !== rootSet.size) throw new Error("Every graph root must exist and match the definition");
  if (roots.length > pattern.maxNodes) throw new Error("Graph roots exceed the node budget");
  return roots;
}

function matchesEndpoints(edge: SelectionEdge, rule: ResolvedPattern["rules"][number], nodes: Map<string,SelectionNode>) {
  return edge.typeId === rule.type && (!rule.fromType || nodes.get(edge.fromId)?.typeId === rule.fromType)
    && (!rule.toType || nodes.get(edge.toId)?.typeId === rule.toType);
}

/** Preserve relationships to missing/bounded endpoints in either direction. */
function boundaryEdges(
  nodes: SelectionNode[], edges: SelectionEdge[], pattern: ResolvedPattern,
  selectedIds: Set<string>, missingIds: Set<string>, leafIds: Set<string>,
) {
  const byNode = new Map(nodes.map(node => [node.id,node]));
  // A node the walk did not expand keeps no edges past the selection either.
  return edges.filter(edge => pattern.rules.some(rule => {
    if (!matchesEndpoints(edge,rule,byNode)) return false;
    const source = rule.direction === "incoming" ? edge.toId : edge.fromId;
    const target = rule.direction === "incoming" ? edge.fromId : edge.toId;
    const sourceNode = byNode.get(source);
    return selectedIds.has(source) && !!sourceNode && !leafIds.has(source) && missingIds.has(target);
  }));
}

/** Adapt published records to the same traversal used by Wiki's saved lenses. */
export function selectGraph(graph: SelectableGraph, rootIds: readonly string[], input: GraphSelectionDefinition): GraphSelection {
  const definition = graphSelectionDefinition.parse(input);
  const { types,nodes,edges } = prepareRecords(graph);
  const names = new Map(types.filter(type => !type.archived).map(type => [type.id, type.name]));
  const typeName = (record: EntityRecord) => names.get(String(record.attributes.typeId)) ?? "";
  const pattern = resolveKnowledgeGraph({ types }, {
    root_type: definition.rootTypes[0], root_types: definition.rootTypes,
    relationships: definition.relationships.map(normalizeRule), max_depth: definition.maxDepth, max_nodes: definition.maxNodes,
    stop_at_types: definition.stopAtTypes,
    stop_after_types: definition.stopAfterTypes,
  });
  const roots = selectionRoots(nodes,rootIds,pattern);
  const typeIdsNamed = (names: readonly string[]) => new Set(types.filter(type => !type.archived && (names.includes(type.id) || names.includes(type.name))).map(type => type.id));
  const terminalTypeIds = typeIdsNamed(definition.terminalTypes);
  // nodeTypes narrows what the walk may reach: the roots and nodes of those types only.
  const reachable = definition.nodeTypes ? typeIdsNamed(definition.nodeTypes) : null;
  const allowedNodeIds = reachable ? new Set([...roots.map(root => root.id), ...nodes.filter(node => reachable.has(node.typeId)).map(node => node.id)]) : undefined;
  const selection = exploreKnowledgeGraph({ nodes, edges }, roots, pattern, { terminalTypeIds, allowedNodeIds });
  const installationId = roots[0]?.record.ref.installationId ?? graph.nodes[0]?.ref.installationId ?? "";
  const ref = (id: string): EntityRef => ({ installationId, type: "graph-node", id });
  const selectedIds = new Set(selection.nodes.map(node => node.id));
  const missingIds = new Set([...selection.omittedIds,...selection.unresolvedIds]);
  const selectedEdgeIds = new Set([
    ...selection.edges, ...boundaryEdges(nodes,edges,pattern,selectedIds,missingIds,new Set(selection.leafIds)),
  ].map(edge => edge.id));
  return { definition, roots: roots.map(node => node.record), nodes: selection.nodes.map(node => node.record).sort(byId),
    edges: edges.filter(edge => selectedEdgeIds.has(edge.id)).map(edge => edge.record).sort(byId), depth: selection.depth,
    omitted: selection.omittedIds.map(ref), unresolved: selection.unresolvedIds.map(ref), incomplete: selection.truncated || pattern.missingTypes.length > 0, missingTypes: pattern.missingTypes, typeName };
}

/** Wiki's shared fetcher. The same bounded view for every consumer; select by a
 * published `KnowledgeGraph` record or an inline definition. */
/** The Wiki KnowledgeGraph node type every Wiki installs. */
export const knowledgeGraphTypeId = "71000000-0000-4000-8000-000000000066";
/** The fields that pick a selection; `knowledge-graph.render` takes them too. */
export const knowledgeGraphSelectFields = {
  /** A `KnowledgeGraph` node whose `root_type` and `pattern` (or JSON body) define the view. */
  definitionId: z.uuid().optional(),
  /** An inline definition, when no record publishes the view yet. */
  definition: graphSelectionDefinition.optional(),
  /** Root nodes, each matching the definition's root types. */
  rootIds: z.array(z.uuid()).min(1).max(32),
  /** Lower the node budget below the definition's. */
  maxNodes: z.number().int().min(1).max(500).optional(),
  /** A GraphQL document to read with instead of the saved or compiled one (a result's `query`, possibly
   * edited; its variable is `$rootIds`). Alone, the selection is what it returns; with a definition,
   * that definition still bounds it. */
  query: z.string().trim().min(1).max(32768).optional(),
};
/** At most one of definitionId or definition, and one of them or a query. */
export const oneDefinition = <T extends { definitionId?: string; definition?: unknown; query?: string }>(input: T) =>
  !(input.definitionId && input.definition) && !!(input.definitionId || input.definition || input.query);
export const oneDefinitionMessage = "Select one of definitionId or definition, or pass a query";
export const knowledgeGraphSelectInput = z.strictObject(knowledgeGraphSelectFields)
  .refine(oneDefinition, { message: oneDefinitionMessage });
export type KnowledgeGraphSelectInput = z.infer<typeof knowledgeGraphSelectInput>;
export const knowledgeGraphSelectResult = z.strictObject({
  definition: graphSelectionDefinition,
  /** The published definition record used, when selected by ID. */
  record: z.strictObject({ ref: entityRef, revision: z.number().int().positive() }).nullable(),
  roots: z.array(entityRef),
  nodes: z.array(entityRecord),
  edges: z.array(entityRecord),
  /** The type definitions the selected nodes and edges use. */
  types: z.array(entityRecord),
  depth: z.record(z.string(), z.number().int().nonnegative()),
  omitted: z.array(entityRef),
  unresolved: z.array(entityRef),
  incomplete: z.boolean(),
  missingTypes: z.array(z.string()).default([]),
  /** The GraphQL document this selection was read with (a KnowledgeGraph body's `query`), its sha256
   * `hash`, and the JSON Schema of its `variables` (`{ rootIds }`). Pass it back as `query`. */
  query: z.string().optional(),
  hash: z.string().optional(),
  variables: z.record(z.string(), z.json()).optional(),
});
export type KnowledgeGraphSelectResult = z.infer<typeof knowledgeGraphSelectResult>;

/** A selection as `knowledge-graph.render` reads it, from records already read. */
export function selectionResult(graph: SelectableGraph, selection: GraphSelection, record: EntityRecord | null, read?: { query: string; hash: string; variables: Record<string, unknown> }): KnowledgeGraphSelectResult {
  const used = new Set([...selection.nodes, ...selection.edges].map((item) => String(item.attributes.typeId)));
  // Typed, not re-parsed: the action's output schema validates it once.
  return {
    definition: selection.definition, record: record ? { ref: record.ref, revision: record.revision } : null,
    roots: selection.roots.map((root) => root.ref), nodes: selection.nodes, edges: selection.edges,
    types: graph.types.filter((type) => used.has(type.ref.id)).sort(byId),
    depth: Object.fromEntries(selection.depth), omitted: selection.omitted, unresolved: selection.unresolved, incomplete: selection.incomplete, missingTypes: selection.missingTypes,
    ...(read ? { query: read.query, hash: read.hash, variables: read.variables as Record<string, z.infer<ReturnType<typeof z.json>>> } : {}),
  };
}

import { z } from "zod";
export type GraphNode = { id: string; typeId: string; archived?: boolean; body?: string; properties?: Record<string, unknown> };
export type GraphEdge = { id: string; typeId: string; fromId: string; toId: string; archived?: boolean; body?: string; properties?: Record<string, unknown> };
export type Graph = { types: { id: string; name: string; category: "node" | "edge"; archived?: boolean }[]; nodes: GraphNode[]; edges: GraphEdge[] };

/** Authored retirement status is hidden by every active lens; raw snapshots retain it. */
export function isRetired(record: { body?: unknown; properties?: unknown }) {
  if ((record.properties as Record<string,unknown> | undefined)?.status === "retired") return true;
  try { return JSON.parse(String(record.body ?? "{}"))?.status === "retired"; }
  catch { return false; }
}

const reference = z.string().trim().min(1).max(120);
const relationship = z
  .object({
    type: reference,
    direction: z.enum(["outgoing", "incoming"]).default("outgoing"),
    from_type: reference.optional(),
    to_type: reference.optional(),
  })
  .strict();
export const graphPattern = z
  .object({
    relationships: z
      .array(
        z.union([
          reference.transform((type) => ({
            type,
            direction: "outgoing" as const,
          })),
          relationship,
        ]),
      )
      .min(1)
      .max(32),
    max_depth: z.number().int().min(1).max(10),
  })
  .strict();
const selectionSchema = z.object({
  relationships: graphPattern.shape.relationships,
  maxDepth: z.number().int().min(1).max(10),
  /** The same bound as a graph_search inline selection, so a view tried there can be saved. */
  maxNodes: z.number().int().min(1).max(500),
  /** Node types reached by the walk that it does not expand further. The starting node always expands. */
  stopAtTypes: z.array(reference).max(32).optional(),
  /** Node types reached by the walk that expand one more step; what they reach is shown but not expanded. */
  stopAfterTypes: z.array(reference).max(32).optional(),
}).strict();
/** A KnowledgeGraph's JSON body: a selection (rootTypes + selection), a saved GraphQL
 * query (query, hash, variables), or both. With a selection, `query` is what it
 * compiles to; without one, the query is the definition and reads run it as written. */
export const knowledgeGraphDefinitionSchema = z.object({
  name: reference,
  purpose: z.string().trim().min(1).max(2000),
  rootTypes: z.array(reference).min(1).max(32).optional(),
  selection: selectionSchema.optional(),
  /** GraphQL document text (graphql-js print output). */
  query: z.string().min(1).max(32768).optional(),
  /** sha256 hex of `query`. */
  hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** JSON Schema of the query's variables. */
  variables: z.record(z.string(), z.json()).optional(),
}).strict().superRefine((value, context) => {
  if (!value.selection && !value.query) context.addIssue({ code: "custom", message: "A KnowledgeGraph needs a selection or a query" });
  if (!!value.selection !== !!value.rootTypes) context.addIssue({ code: "custom", message: "rootTypes and selection go together" });
  if (!value.query && (value.hash || value.variables)) context.addIssue({ code: "custom", message: "hash and variables describe a query" });
});
export type KnowledgeGraphDefinition = z.infer<typeof knowledgeGraphDefinitionSchema>;
/** A saved GraphQL query with no selection: reads run its document as written. */
export const isSavedQuery = (definition: KnowledgeGraphDefinition | undefined) => !!definition?.query && !definition.selection;
export function contextDefinition(node: { body?: string }) {
  if (!node.body?.trim().startsWith("{")) return undefined;
  return knowledgeGraphDefinitionSchema.parse(JSON.parse(node.body));
}
export type GraphPattern = z.infer<typeof graphPattern> & {
  root_type: string;
  root_types?: string[];
  max_nodes?: number;
  stop_at_types?: string[];
  stop_after_types?: string[];
};

/** A JSON-body definition as the pattern the traversal reads. */
export function definitionPattern(definition: KnowledgeGraphDefinition): GraphPattern {
  if (!definition.selection || !definition.rootTypes) throw new Error("This KnowledgeGraph is a saved GraphQL query without a selection");
  return {
    root_type: definition.rootTypes[0],
    root_types: definition.rootTypes,
    relationships: definition.selection.relationships,
    max_depth: definition.selection.maxDepth,
    max_nodes: definition.selection.maxNodes,
    stop_at_types: definition.selection.stopAtTypes,
    stop_after_types: definition.selection.stopAfterTypes,
  };
}
/** A lens selects existing relationships; it never defines facts or access rights. */
export function parseKnowledgeGraph(
  node: Pick<GraphNode, "properties"> & { body?: string },
): GraphPattern {
  const definition = contextDefinition(node);
  if (definition) return definitionPattern(definition);
  return {
    ...graphPattern.parse(JSON.parse(String(node.properties?.pattern ?? ""))),
    root_type: reference.parse(node.properties?.root_type),
  };
}

type TypeRegistry = {
  types: Pick<
    Graph["types"][number],
    "id" | "name" | "category" | "archived"
  >[];
};

/** Names are exact registry names, not display titles; UUIDs remain supported. */
function resolveType(
  graph: TypeRegistry,
  value: string,
  category: "node" | "edge",
) {
  const matches = graph.types.filter(
    (type) =>
      !type.archived &&
      type.category === category &&
      (type.id === value || type.name === value),
  );
  if (matches.length !== 1)
    throw new Error(`Unknown or ambiguous ${category} type: ${value}`);
  return matches[0].id;
}
/** An archived rule type is a disabled path; an unknown or ambiguous type is still an invalid definition. */
function resolveRuleType(
  graph: TypeRegistry,
  value: string,
  category: "node" | "edge",
) {
  const candidates = graph.types.filter(
    (type) =>
      type.category === category && (type.id === value || type.name === value),
  );
  const active = candidates.filter((type) => !type.archived);
  if (active.length === 1) return active[0].id;
  if (active.length === 0 && candidates.length === 1 && candidates[0].archived)
    return null;
  throw new Error(`Unknown or ambiguous ${category} type: ${value}`);
}
export function resolveKnowledgeGraph(
  graph: TypeRegistry,
  pattern: GraphPattern,
) {
  const missingTypes: string[] = [];
  const resolve = (value: string, category: "node" | "edge") => {
    if (!pattern.root_types) return resolveRuleType(graph, value, category);
    const matches = graph.types.filter(type => !type.archived && type.category === category && (type.id === value || type.name === value));
    if (matches.length > 1) throw new Error(`Ambiguous ${category} type: ${value}`);
    if (matches.length === 1) return matches[0].id;
    const archived = graph.types.filter(type => type.archived && type.category === category && (type.id === value || type.name === value));
    if (archived.length === 1) return null;
    missingTypes.push(value);
    return undefined;
  };
  const rootTypes = (pattern.root_types ?? [pattern.root_type]).flatMap(value => {
    const id = pattern.root_types ? resolve(value, "node") : resolveType(graph, value, "node");
    return id ? [id] : [];
  });
  const rules = pattern.relationships.flatMap(rule => {
    const type = resolve(rule.type, "edge");
    const fromType = "from_type" in rule && rule.from_type ? resolve(rule.from_type, "node") : undefined;
    const toType = "to_type" in rule && rule.to_type ? resolve(rule.to_type, "node") : undefined;
    if (!type || fromType === null || toType === null || ("from_type" in rule && rule.from_type && !fromType) || ("to_type" in rule && rule.to_type && !toType)) return [];
    return [{ ...rule, type, ...(fromType ? { fromType } : {}), ...(toType ? { toType } : {}) }];
  });
  if (pattern.root_types && (!rootTypes.length || (!rules.length && missingTypes.length > 0))) throw new Error("No supported root types or relationships for this context graph");
  // A stop type this Wiki lacks stops nothing, so it is not a context gap.
  const nodeTypeIds = (values: string[] = []) => values.flatMap(value =>
    graph.types.filter(type => !type.archived && type.category === "node" && (type.id === value || type.name === value)).map(type => type.id));
  const stopAtTypes = nodeTypeIds(pattern.stop_at_types);
  const stopAfterTypes = nodeTypeIds(pattern.stop_after_types);
  return {
    rootType: rootTypes[0], rootTypes, stopAtTypes, stopAfterTypes,
    maxDepth: pattern.max_depth,
    maxNodes: pattern.max_nodes ?? 200,
    rules, missingTypes,
  };
}
export type ResolvedGraphPattern = ReturnType<typeof resolveKnowledgeGraph>;
export function loadKnowledgeGraph(
  graph: Pick<Graph, "types">,
  node: GraphNode,
) {
  return resolveKnowledgeGraph(graph, parseKnowledgeGraph(node));
}
export type GraphSelectionBoundary = { allowedNodeIds?: ReadonlySet<string>; priorityNodeIds?: ReadonlySet<string>; terminalTypeIds?: ReadonlySet<string> };

function matchesRule(edge: GraphEdge, nodes: Map<string, GraphNode>, rule: ResolvedGraphPattern["rules"][number]) {
  return edge.typeId === rule.type && (!rule.fromType || nodes.get(edge.fromId)?.typeId === rule.fromType) &&
    (!rule.toType || nodes.get(edge.toId)?.typeId === rule.toType);
}

/** The single saved-lens traversal used by Wiki reads and SDK consumers. */
export function exploreKnowledgeGraph<N extends GraphNode, E extends GraphEdge>(
  graph: { nodes: N[]; edges: E[] }, anchor: N | readonly N[], definition: ResolvedGraphPattern,
  boundary: GraphSelectionBoundary = {},
) {
  const hidden = new Set(graph.nodes.filter(n => n.archived || isRetired(n)).map(n => n.id));
  const nodes = new Map(graph.nodes.filter(n => !hidden.has(n.id)).map(n => [n.id,n]));
  const visibleEdges = graph.edges.filter(edge => !hidden.has(edge.fromId) && !hidden.has(edge.toId));
  const steps = graphSteps(nodes,visibleEdges,definition);
  const anchors: readonly N[] = Array.isArray(anchor) ? anchor : [anchor as N];
  const roots = canonicalRoots(nodes,anchors,boundary.allowedNodeIds);
  return walkGraph(nodes, steps, roots, definition, boundary, graphStops(nodes, new Set(anchors.map(node => node.id)), definition, boundary));
}
/**
 * Which reached records the walk shows without expanding ("leaves"). Terminal
 * types never expand; stop-at types expand only as a starting record; a
 * non-root stop-after record expands one step, and what it reaches is a leaf.
 */
type GraphStops = { leaf: (id: string, fromLeafParent: boolean) => boolean; childrenAreLeaves: (id: string) => boolean };
function graphStops(nodes: Map<string, GraphNode>, anchorIds: ReadonlySet<string>, definition: ResolvedGraphPattern, boundary: GraphSelectionBoundary): GraphStops {
  const typeOf = (id: string) => nodes.get(id)?.typeId ?? "";
  return {
    leaf: (id, fromLeafParent) => fromLeafParent || !!boundary.terminalTypeIds?.has(typeOf(id)) || (!anchorIds.has(id) && definition.stopAtTypes.includes(typeOf(id))),
    childrenAreLeaves: id => !anchorIds.has(id) && definition.stopAfterTypes.includes(typeOf(id)),
  };
}
function canonicalRoots<N extends GraphNode>(nodes: Map<string,N>, anchors: readonly N[], allowed?: ReadonlySet<string>) {
  return [...new Map(anchors.filter(node => nodes.has(node.id) && (!allowed || allowed.has(node.id))).map(node => [node.id,node])).values()]
    .sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function graphSteps<N extends GraphNode, E extends GraphEdge>(nodes: Map<string,N>, edges: E[], definition: ResolvedGraphPattern) {
  const steps = new Map<string, { target: string; edge: E }[]>();
  for (const edge of edges.filter(e => !e.archived && !isRetired(e)).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    for (const rule of definition.rules) {
      if (!matchesRule(edge,nodes,rule)) continue;
      const source = rule.direction === "incoming" ? edge.toId : edge.fromId;
      const target = rule.direction === "incoming" ? edge.fromId : edge.toId;
      const list = steps.get(source) ?? [];
      list.push({ target, edge }); steps.set(source, list);
    }
  }
  return steps;
}

type Reach = { depth: number; leaf: boolean };
/** A path that expands a record wins over an equally short one that does not. */
const supersedes = (seen: Reach | undefined, next: Reach) => !seen || (seen.leaf && !next.leaf && seen.depth === next.depth);

/** The same breadth-first reach as the walk, without a node budget: each reachable record's parent. */
function reachableParents<N extends GraphNode, E extends GraphEdge>(
  nodes: Map<string,N>, steps: Map<string, {target:string;edge:E}[]>, anchors: readonly N[],
  maxDepth: number, stops: GraphStops, allowed?: ReadonlySet<string>,
) {
  const parents = new Map<string,string | null>(anchors.map(anchor => [anchor.id,null]));
  const queue = anchors.map(anchor => ({id:anchor.id, depth:0, leaf:stops.leaf(anchor.id,false)}));
  const reached = new Map<string,Reach>(queue.map(({id,...reach}) => [id,reach]));
  for (let i=0; i<queue.length; i++) {
    const {id,depth,leaf}=queue[i];
    if (leaf || depth>=maxDepth || reached.get(id)?.leaf !== leaf) continue;
    const childLeaf = stops.childrenAreLeaves(id);
    for (const {target} of steps.get(id) ?? []) {
      const next = {depth:depth+1, leaf:stops.leaf(target,childLeaf)};
      if (!nodes.has(target) || (allowed && !allowed.has(target)) || !supersedes(reached.get(target),next)) continue;
      parents.set(target,id); reached.set(target,next); queue.push({id:target, ...next});
    }
  }
  return parents;
}

function priorityPaths<N extends GraphNode, E extends GraphEdge>(
  nodes: Map<string,N>, steps: Map<string, {target:string;edge:E}[]>, anchors: readonly N[],
  definition: ResolvedGraphPattern, boundary: GraphSelectionBoundary, stops: GraphStops,
) {
  const parents=reachableParents(nodes,steps,anchors,definition.maxDepth,stops,boundary.allowedNodeIds);
  const reserved = new Set<string>(anchors.map(anchor => anchor.id));
  for (const id of boundary.priorityNodeIds ?? []) {
    if (!parents.has(id)) continue;
    let current: string | null = id;
    while (current !== null && !reserved.has(current)) {
      reserved.add(current); current=parents.get(current) ?? null;
    }
  }
  return {reserved, unreachablePriorityIds:[...(boundary.priorityNodeIds ?? [])].filter(id=>!parents.has(id)).sort()};
}

type WalkState<N extends GraphNode,E extends GraphEdge> = {
  definition: ResolvedGraphPattern; boundary: GraphSelectionBoundary;
  nodes: Map<string,N>; selected: Map<string,N>; edges: Map<string,E>;
  depth: Map<string,number>; queue: {id:string;depth:number;leaf:boolean}[]; leaves: Set<string>;
  omitted: Set<string>; excluded: Set<string>; unresolved: Set<string>;
  reserved: Set<string>; reservedRemaining: number; metadataTruncated: boolean; stops: GraphStops;
};
function recordReference<N extends GraphNode,E extends GraphEdge>(state: WalkState<N,E>, set: Set<string>, id:string) {
  if (set.size < state.definition.maxNodes) set.add(id);
  else if (set !== state.excluded) state.metadataTruncated = true;
}
function admitNode<N extends GraphNode,E extends GraphEdge>(state: WalkState<N,E>, node:N, depth:number, fromLeafParent = false) {
  const leaf = state.stops.leaf(node.id, fromLeafParent);
  if (state.selected.has(node.id)) {
    // A path that expands a record wins over an equally short one that does not.
    if (!leaf && state.leaves.has(node.id) && state.depth.get(node.id) === depth) {
      state.leaves.delete(node.id); state.queue.push({id:node.id,depth,leaf});
    }
    return true;
  }
  const reserved=state.reserved.has(node.id);
  const limit=reserved ? state.definition.maxNodes : state.definition.maxNodes-state.reservedRemaining;
  if (state.selected.size>=limit) { recordReference(state,state.omitted,node.id); return false; }
  state.selected.set(node.id,node); state.depth.set(node.id,depth);
  state.reservedRemaining-=Number(reserved); state.queue.push({id:node.id,depth,leaf});
  if (leaf) state.leaves.add(node.id);
  return true;
}
function visitReference<N extends GraphNode,E extends GraphEdge>(state: WalkState<N,E>, target:string, edge:E, depth:number, leaf:boolean) {
  const node=state.nodes.get(target);
  if (!node) { recordReference(state,state.unresolved,target); return; }
  if (state.boundary.allowedNodeIds && !state.boundary.allowedNodeIds.has(target)) { recordReference(state,state.excluded,target); return; }
  if (depth>=state.definition.maxDepth) {
    if (state.selected.has(target)) state.edges.set(edge.id,edge);
    else recordReference(state,state.omitted,target);
  } else if (admitNode(state,node,depth+1,leaf)) state.edges.set(edge.id,edge);
}
function walkGraph<N extends GraphNode, E extends GraphEdge>(
  nodes: Map<string,N>, steps: Map<string, {target:string;edge:E}[]>, anchors: readonly N[],
  definition: ResolvedGraphPattern, boundary: GraphSelectionBoundary, stops: GraphStops,
) {
  const priority = boundary.priorityNodeIds ? priorityPaths(nodes,steps,anchors,definition,boundary,stops) : {reserved:new Set(anchors.map(anchor => anchor.id)),unreachablePriorityIds:[] as string[]};
  const state: WalkState<N,E> = {definition,boundary,nodes,selected:new Map(),edges:new Map(),depth:new Map(),queue:[],
    omitted:new Set(),excluded:new Set(),unresolved:new Set(),leaves:new Set(),reserved:priority.reserved,reservedRemaining:priority.reserved.size,metadataTruncated:false,stops};
  for (const anchor of anchors) admitNode(state,anchor,0);
  for (let i=0; i<state.queue.length; i++) {
    const {id,depth,leaf}=state.queue[i];
    // Leaves are shown, not expanded; an entry superseded by an expanding path is skipped.
    if (leaf || state.leaves.has(id)) continue;
    const childLeaf = stops.childrenAreLeaves(id);
    for (const {target,edge} of steps.get(id) ?? []) visitReference(state,target,edge,depth,childLeaf);
  }
  return { depth:state.depth, nodes:[...state.selected.values()], edges:[...state.edges.values()], truncated:state.omitted.size>0 || state.metadataTruncated,
    unreachablePriorityIds:priority.unreachablePriorityIds,
    leafIds:[...state.leaves].sort(), omittedIds:[...state.omitted].sort(), excludedIds:[...state.excluded].sort(), unresolvedIds:[...state.unresolved].sort() };
}

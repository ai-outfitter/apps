// A KnowledgeGraph selection as a GraphQL document over the generated schema.
// The selection format (graph-selection.ts) stays the stored description; this
// compiles it into the document that reads it, and maps a result back.
//
// Compilation: one fragment on Node per hop (Step1…StepN, then Beyond), so the
// document grows with rules times depth, not with the data or the number of types.
// Each hop selects edge objects, so the result carries edge IDs as well as nodes:
// - typed `<edge>Edges` / `<edge>IncomingEdges` fields, inside `... on <Type>`, where
//   the edge type declares ontology endpoints;
// - otherwise `edges(types: [...], direction: ...)`, aliased `<edge>Links` /
//   `<edge>IncomingLinks`, inside `... on <Type>` when a guard names one source type,
//   on Node otherwise.
// Roots come from each root type's collection (`slugs: $roots`, `first` from
// maxNodes). Each record carries id, typeId, title and slug (the address agents use).
// Beyond selects the last hop's edges once more, with only the far end's id and typeId,
// so a reader can tell omitted records from missing ones. Terminal
// types carry no fields; a hop into terminal types only does not spread the next step.
// The document reads a superset; the exact walk (guards, budget order, depth,
// omitted, boundary edges) stays `selectGraph`, run over the records the result holds.
// Text is graphql-js `print` output, so a definition always compiles to the same text.
import { parse, print } from "graphql";
import { endpointsOf, graphqlNames, type NodeLayout, type SchemaLayout, schemaLayout, type TypeRow } from "./graph-graphql-names";
import type { EdgeRow, GraphRow } from "./graph-graphql-source";
import { type GraphSelection, type GraphSelectionDefinition, graphSelectionDefinition, normalizeRule, selectGraph } from "./graph-selection";
import { wikiGraphRecords } from "./graph-records";

export type SelectionDocument = {
  /** The GraphQL document as graphql-js `print`s it, so one definition always compiles to the same text.
   * Its only variable is `$roots: [String!]!`, the root nodes' slugs. */
  query: string;
  operationName: string;
  /** JSON Schema of the operation's variables. */
  variables: typeof selectionVariables;
  /** Selection hops the document spans. */
  hops: number;
};
/** The variables every compiled selection takes: its root nodes' slugs, which agents
 * read and send instead of UUIDs. */
export const selectionVariables = {
  type: "object", additionalProperties: false, required: ["roots"],
  properties: { roots: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1, maxLength: 80 }, description: "Root node slugs, each of one of the selection's root types." } },
} as const;
const roundConstants = Uint32Array.from({ length: 64 }, (_, index) => {
  const primes: number[] = [];
  for (let candidate = 2; primes.length < 64; candidate++) if (primes.every(prime => candidate % prime)) primes.push(candidate);
  return Math.floor((Math.cbrt(primes[index]) % 1) * 2 ** 32);
});
const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
/** sha256 hex of a query's UTF-8 text: the identity a saved query is published under. Synchronous,
 * so a write can check a stored `hash` where it validates the rest of the body. */
export function queryHash(query: string) {
  const text = new TextEncoder().encode(query);
  const bytes = new Uint8Array(Math.ceil((text.length + 9) / 64) * 64);
  bytes.set(text);
  bytes[text.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(bytes.length - 8, Math.floor(text.length / 2 ** 29));
  view.setUint32(bytes.length - 4, text.length * 8);
  const hash = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 64; index++) {
      if (index < 16) { words[index] = view.getUint32(offset + index * 4); continue; }
      const [low, high] = [words[index - 15], words[index - 2]];
      words[index] = words[index - 16] + (rotate(low, 7) ^ rotate(low, 18) ^ (low >>> 3)) + words[index - 7] + (rotate(high, 17) ^ rotate(high, 19) ^ (high >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + roundConstants[index] + words[index]) >>> 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + first) >>> 0, c, b, a, (first + second) >>> 0];
    }
    for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) hash[index] += value;
  }
  return [...hash].map(word => word.toString(16).padStart(8, "0")).join("");
}
/** Query depth a compiled document of `maxDepth` hops needs (collection, nodes, two levels per hop, frontier). */
export const selectionQueryDepth = (maxDepth: number) => 2 * maxDepth + 5;

type Rule = { edgeTypeId: string; direction: "outgoing" | "incoming"; fromType?: string; toType?: string };
/** One edge field: where it is selected (a node type, or "" for every node), and the types it may reach. */
type Hop = { on: string; field: string; alias?: string; args?: string; end: "to" | "from"; targets: string[] };

const quote = (value: string) => JSON.stringify(value);
const layoutOf = (schema: SchemaLayout | TypeRow[]) => (Array.isArray(schema) ? schemaLayout(schema) : schema);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Resolve a definition's type references (names or IDs) against the schema's types. */
function resolveRules(definition: GraphSelectionDefinition, layout: SchemaLayout) {
  const index = (map: Map<string, { type: TypeRow }>) => {
    const found = new Map<string, string>();
    for (const { type } of map.values()) for (const key of [type.id, type.name]) found.set(key, type.id);
    return found;
  };
  const nodes = index(layout.nodes), edges = index(layout.edges);
  const rules = definition.relationships.map(normalizeRule).flatMap((rule): Rule[] => {
    const edgeTypeId = edges.get(rule.type);
    const fromType = rule.from_type === undefined ? undefined : nodes.get(rule.from_type);
    const toType = rule.to_type === undefined ? undefined : nodes.get(rule.to_type);
    // An unknown or archived type matches nothing; selectGraph reports what is missing.
    if (!edgeTypeId || (rule.from_type !== undefined && !fromType) || (rule.to_type !== undefined && !toType)) return [];
    return [{ edgeTypeId, direction: rule.direction, ...(fromType ? { fromType } : {}), ...(toType ? { toType } : {}) }];
  });
  const typeIds = (refs: string[]) => [...new Set(refs.flatMap(ref => nodes.get(ref) ?? []))];
  return { rules, roots: typeIds(definition.rootTypes), terminal: new Set(typeIds(definition.terminalTypes)) };
}

type Group = { edgeTypeId: string; direction: Rule["direction"]; sources: Set<string> | null; targets: Set<string> | null };
/** Rules of one edge type and direction, with the union of their source and target guards (null: any type). */
function groupRules(rules: Rule[]) {
  const groups = new Map<string, Group>();
  const widen = (set: Set<string> | null, guard: string | undefined) => (!guard || set === null ? null : set.add(guard));
  for (const rule of rules) {
    const key = `${rule.edgeTypeId}:${rule.direction}`;
    const group = groups.get(key) ?? { edgeTypeId: rule.edgeTypeId, direction: rule.direction, sources: new Set<string>(), targets: new Set<string>() };
    const [source, target] = rule.direction === "outgoing" ? [rule.fromType, rule.toType] : [rule.toType, rule.fromType];
    group.sources = widen(group.sources, source);
    group.targets = widen(group.targets, target);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Typed `…Edges` fields on each endpoint type; otherwise `edges(types:, direction:)`, on every node unless a guard names the source types. */
function hopsOf(group: Group, layout: SchemaLayout, terminal: Set<string>): Hop[] {
  const end = group.direction === "outgoing" ? "to" : "from";
  const allowed = (ids: string[]) => ids.filter(id => !group.targets || group.targets.has(id));
  const typed = [...layout.nodes.values()].flatMap(node => {
    if (terminal.has(node.type.id) || (group.sources && !group.sources.has(node.type.id))) return [];
    const relation = node.relationships.find(item => item.edges && !item.projection && item.edgeType.id === group.edgeTypeId && item.direction === group.direction);
    const targets = relation ? allowed(relation.targets) : [];
    return relation && targets.length ? [{ on: node.type.id, field: relation.field, end, targets } satisfies Hop] : [];
  });
  const edge = layout.edges.get(group.edgeTypeId);
  if (!edge || endpointsOf(edge.type)) return typed;
  const alias = `${graphqlNames.fieldName(edge.type.name)}${group.direction === "incoming" ? "Incoming" : ""}Links`;
  const generic = { field: "edges", alias, args: `(types: [${quote(edge.type.name)}], direction: ${group.direction === "outgoing" ? "OUTGOING" : "INCOMING"})`, end,
    targets: allowed([...layout.nodes.keys()]) } as const;
  if (!generic.targets.length) return [];
  // One source type gets its own inline fragment; several share the field on Node (the walk applies the guard),
  // which keeps a document with many guarded rules small.
  const sources = group.sources ? [...group.sources].filter(id => !terminal.has(id)) : null;
  if (sources && !sources.length) return [];
  return sources?.length === 1 ? [{ ...generic, on: sources[0] }] : [{ ...generic, on: "" }];
}

/** Compile a selection into one GraphQL document over the schema generated from `schema`. */
export function selectionDocument(input: GraphSelectionDefinition, schema: SchemaLayout | TypeRow[], options: { operationName?: string } = {}): SelectionDocument {
  const definition = graphSelectionDefinition.parse(input);
  const layout = layoutOf(schema);
  const { rules, roots, terminal } = resolveRules(definition, layout);
  const hops = groupRules(rules).flatMap(group => hopsOf(group, layout, terminal));
  if (!roots.length) throw new Error("No root type of this selection is in the schema");
  const nameOf = (typeId: string) => (layout.nodes.get(typeId) as NodeLayout).name;
  const step = (level: number) => (level > definition.maxDepth ? "Beyond" : `Step${level}`);
  /** The fields reading hop `level` out of a node; past maxDepth only the far end's id and typeId. */
  const fields = (level: number, on: string) => hops.filter(hop => hop.on === on).map(hop => {
    const head = `${hop.alias ? `${hop.alias}: ` : ""}${hop.field}${hop.args ?? ""}`;
    if (level > definition.maxDepth) return `${head} { ...Link ${hop.end} { id typeId } }`;
    const expands = hops.length && hop.targets.some(target => !terminal.has(target));
    return `${head} { ...Link ${hop.end} { ...Record${expands ? ` ...${step(level + 1)}` : ""} } }`;
  });
  const placements = [...new Set(hops.map(hop => hop.on))].sort((a, b) => (a && b ? compare(nameOf(a), nameOf(b)) : a ? 1 : -1));
  const fragment = (level: number) => {
    const body = placements.flatMap(on => (on ? [`... on ${nameOf(on)} {\n    ${fields(level, on).join("\n    ")}\n  }`] : fields(level, on)));
    return `fragment ${step(level)} on Node {\n  ${body.join("\n  ")}\n}`;
  };
  const operationName = options.operationName ?? "KnowledgeGraph";
  const first = Math.min(definition.maxNodes, 500);
  const rootFields = roots.map(typeId => `  ${(layout.nodes.get(typeId) as NodeLayout).collection}(slugs: $roots, first: ${first}) { nodes { ...Record${hops.length ? " ...Step1" : ""} } }`);
  const levels = hops.length ? Array.from({ length: definition.maxDepth + 1 }, (_, index) => fragment(index + 1)) : [];
  const document = [
    `query ${operationName}($roots: [String!]!) {\n${rootFields.join("\n")}\n}`,
    "fragment Record on Node { id typeId title slug }",
    "fragment Link on Edge { id typeId fromId toId }",
    ...levels,
  ].join("\n");
  return { query: print(parse(document)), operationName, variables: selectionVariables, hops: definition.maxDepth };
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isRecord = (value: Record<string, unknown>): value is GraphRow => typeof value.id === "string" && typeof value.typeId === "string";
const isEdge = (value: GraphRow): value is EdgeRow => typeof value.fromId === "string" && typeof value.toId === "string";
type Observed = { nodes: Map<string, GraphRow>; edges: Map<string, EdgeRow>; depth: Map<string, number>; steps: Set<string> };

function noteEdge(edge: EdgeRow, observed: Observed, parent: GraphRow | null) {
  observed.edges.set(edge.id, { ...edge, ...observed.edges.get(edge.id) });
  const incoming = parent?.id === edge.toId && parent.id !== edge.fromId;
  if (parent) observed.steps.add(`${edge.typeId}:${incoming ? "incoming" : "outgoing"}`);
}
/** Record a node; its depth is one more than the node above it (0 for a root). */
function noteNode(node: GraphRow, observed: Observed, parent: GraphRow | null, depth: number) {
  observed.nodes.set(node.id, { ...node, ...observed.nodes.get(node.id) });
  const reached = parent ? depth + 1 : 0;
  observed.depth.set(node.id, Math.min(observed.depth.get(node.id) ?? reached, reached));
  return reached;
}

/** Walk a result: every object with id and typeId is a record (edges also have fromId and toId).
 * A node's depth counts the nodes above it; an edge under a node is a step out of it. */
function observe(value: unknown, observed: Observed, parent: GraphRow | null, depth: number) {
  if (Array.isArray(value)) { for (const item of value) observe(item, observed, parent, depth); return; }
  if (!isObject(value)) return;
  let below = parent, next = depth;
  if (isRecord(value) && isEdge(value)) noteEdge(value, observed, parent);
  else if (isRecord(value)) { next = noteNode(value, observed, parent, depth); below = value; }
  // Stored JSON is data, never more records.
  for (const [key, item] of Object.entries(value)) if (key !== "properties") observe(item, observed, below, next);
}

/** The node and edge records a GraphQL result holds, merged by ID (fuller selections win field by field). */
export function resultRecords(data: unknown) {
  const observed: Observed = { nodes: new Map(), edges: new Map(), depth: new Map(), steps: new Set() };
  observe(data, observed, null, 0);
  return { nodes: [...observed.nodes.values()], edges: [...observed.edges.values()], depth: observed.depth, steps: observed.steps };
}

/** A definition describing what a hand-written document read: the root records' types,
 * the edge types and directions it stepped along, and its deepest hop. */
export function definitionFromResult(data: unknown, types: TypeRow[], rootIds: readonly string[], bounds: { id?: string; maxNodes: number }): GraphSelectionDefinition {
  const found = resultRecords(data);
  const names = new Map(types.map(type => [type.id, type.name]));
  const roots = new Set(rootIds);
  const rootTypes = [...new Set(found.nodes.filter(node => roots.has(node.id)).flatMap(node => names.get(node.typeId) ?? []))];
  const relationships = [...found.steps].sort().flatMap(step => {
    const [typeId, direction] = step.split(":");
    const type = names.get(typeId);
    return type ? [{ type, direction: direction as "outgoing" | "incoming" }] : [];
  });
  const depth = Math.max(1, ...found.depth.values());
  if (!rootTypes.length) throw new Error("The document returned none of the root nodes");
  if (!relationships.length) relationships.push({ type: types.find(type => type.category === "edge" && !type.archived)?.name ?? "", direction: "outgoing" });
  return graphSelectionDefinition.parse({ id: bounds.id ?? "graphql", version: 1, purpose: "Read by a GraphQL document.", rootTypes,
    relationships, maxDepth: Math.min(depth, 10), maxNodes: bounds.maxNodes, terminalTypes: [] });
}

/** Run the selection walk over the records a result holds. `records` are fuller rows
 * (for example the roots as stored) that replace what the result selected of them. */
export function selectFromResult(args: { installationId: string; types: TypeRow[]; data: unknown; rootIds: readonly string[]; definition: GraphSelectionDefinition; records?: GraphRow[] }): GraphSelection {
  const found = resultRecords(args.data);
  const fuller = new Map((args.records ?? []).map(row => [row.id, row]));
  const rows = (list: GraphRow[]) => list.map((row): Record<string, unknown> => ({ title: "", body: "", properties: {}, archived: false, revision: 1, ...(row as Record<string, unknown>), ...fuller.get(row.id) }));
  const graph = wikiGraphRecords({ installationId: args.installationId, types: args.types as never, nodes: rows(found.nodes) as never, edges: rows(found.edges) as never }, true);
  return selectGraph(graph, args.rootIds, args.definition);
}

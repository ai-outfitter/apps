import type { KnowledgeGraphDefinition, ResolvedGraphPattern } from "./knowledge-graphs";

/**
 * A knowledge graph built from URL params on an entity's Knowledge graphs
 * page, so the member or the sidebar agent can shape a graph before saving it:
 *
 *   <type>/<id>/knowledge-graphs?rel=part_of:incoming:Project>Organization&rel=has_use_case&stop=Organization&depth=2&max=100
 *
 * `rel` repeats, one relationship type name each, `:incoming` to follow it
 * backwards, and `:<From>><To>` to only follow it between those record types
 * (either side may be empty). `stop` repeats, one record type the walk shows
 * but does not expand past. `after` repeats, one record type the walk expands
 * one more step from; what that step reaches is shown but not expanded. `graph` names the saved knowledge graph being
 * adjusted, so a member can update it. The entity in the path is the root.
 * The params map one to one onto a saved KnowledgeGraph definition.
 */
export type GraphQueryRule = { type: string; direction: "outgoing" | "incoming"; from_type?: string; to_type?: string };
export type GraphQuery = {
  relationships: GraphQueryRule[];
  maxDepth: number;
  maxNodes: number;
  stopAtTypes: string[];
  stopAfterTypes: string[];
  graphId?: string;
};
const name = /^[\w .-]{1,120}$/;
const id = /^[\w-]{1,80}$/;
const bounded = (value: string | null, fallback: number, max: number) => {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number >= 1 ? Math.min(number, max) : fallback;
};

/** `From>To` record type ends; either side may be empty. */
function parseEnds(value: string): Pick<GraphQueryRule, "from_type" | "to_type"> | null {
  const ends = value.split(">").map((end) => end.trim());
  if (ends.length !== 2 || ends.some((end) => end && !name.test(end))) return null;
  const [from, to] = ends;
  return { ...(from ? { from_type: from } : {}), ...(to ? { to_type: to } : {}) };
}
function parseRule(value: string): GraphQueryRule | null {
  const [rawType, ...rest] = value.split(":");
  const type = rawType.trim();
  const direction = rest[0] === "incoming" || rest[0] === "outgoing" ? (rest.shift() as GraphQueryRule["direction"]) : "outgoing";
  if (!name.test(type) || rest.length > 1) return null;
  const ends = rest.length ? parseEnds(rest[0]) : {};
  return ends ? { type, direction, ...ends } : null;
}
/** The `rel` value for `rule`; parseRule reads it back. */
export function ruleParam(rule: GraphQueryRule) {
  const ends = rule.from_type || rule.to_type ? `:${rule.from_type ?? ""}>${rule.to_type ?? ""}` : "";
  return `${rule.type}${rule.direction === "incoming" ? ":incoming" : ""}${ends}`;
}

const typeNames = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter((value) => name.test(value)))].slice(0, 32);
/** The query in `params`, or null when the URL asks for none. Malformed `rel` and `stop` values are dropped. */
export function parseGraphQuery(params: URLSearchParams): GraphQuery | null {
  const relationships = params.getAll("rel").flatMap((value) => parseRule(value) ?? []);
  if (!relationships.length) return null;
  const graphId = params.get("graph")?.trim();
  return {
    relationships: relationships.slice(0, 32),
    maxDepth: bounded(params.get("depth"), 2, 10),
    maxNodes: bounded(params.get("max"), 100, 200),
    stopAtTypes: typeNames(params.getAll("stop")),
    stopAfterTypes: typeNames(params.getAll("after")),
    ...(graphId && id.test(graphId) ? { graphId } : {}),
  };
}

/** The params that rebuild `query`; a saved graph links to them to be adjusted. */
export function graphQueryParams(query: GraphQuery) {
  const params = new URLSearchParams();
  for (const rule of query.relationships) params.append("rel", ruleParam(rule));
  for (const type of query.stopAtTypes) params.append("stop", type);
  for (const type of query.stopAfterTypes) params.append("after", type);
  params.set("depth", String(query.maxDepth));
  params.set("max", String(query.maxNodes));
  if (query.graphId) params.set("graph", query.graphId);
  return params;
}

/** The saved definition for `query`; the draft is drawn from this same definition. */
export function queryDefinition(query: GraphQuery, { rootTypes, name, purpose }: { rootTypes: string[]; name: string; purpose: string }): KnowledgeGraphDefinition {
  return {
    name,
    purpose,
    rootTypes,
    selection: {
      relationships: query.relationships,
      maxDepth: query.maxDepth,
      maxNodes: query.maxNodes,
      ...(query.stopAtTypes.length ? { stopAtTypes: query.stopAtTypes } : {}),
      ...(query.stopAfterTypes.length ? { stopAfterTypes: query.stopAfterTypes } : {}),
    },
  };
}

/** A stored definition that has a selection (a saved GraphQL query alone has none to adjust). */
export type SelectionDefinition = KnowledgeGraphDefinition & Required<Pick<KnowledgeGraphDefinition, "rootTypes" | "selection">>;
export const hasSelection = (definition: KnowledgeGraphDefinition | undefined): definition is SelectionDefinition => !!definition?.selection && !!definition.rootTypes;
type SavedPattern = Pick<ResolvedGraphPattern, "rules" | "maxDepth" | "maxNodes" | "stopAtTypes" | "stopAfterTypes">;
/** A stored JSON definition as a query, kept exactly as written (names or ids). */
export function definitionQuery(definition: SelectionDefinition, graphId?: string): GraphQuery {
  return {
    relationships: definition.selection.relationships.map((rule) => (typeof rule === "string" ? { type: rule, direction: "outgoing" } : rule)),
    maxDepth: definition.selection.maxDepth,
    maxNodes: definition.selection.maxNodes,
    stopAtTypes: definition.selection.stopAtTypes ?? [],
    stopAfterTypes: definition.selection.stopAfterTypes ?? [],
    ...(graphId ? { graphId } : {}),
  };
}
/** A saved pattern as a query, with type ids turned back into names. */
export function patternQuery(pattern: SavedPattern, typeName: (id: string) => string, graphId?: string): GraphQuery {
  return {
    relationships: pattern.rules.map((rule) => ({
      type: typeName(rule.type),
      direction: rule.direction,
      ...(rule.fromType ? { from_type: typeName(rule.fromType) } : {}),
      ...(rule.toType ? { to_type: typeName(rule.toType) } : {}),
    })),
    maxDepth: pattern.maxDepth,
    maxNodes: pattern.maxNodes,
    stopAtTypes: pattern.stopAtTypes.map(typeName),
    stopAfterTypes: pattern.stopAfterTypes.map(typeName),
    ...(graphId ? { graphId } : {}),
  };
}

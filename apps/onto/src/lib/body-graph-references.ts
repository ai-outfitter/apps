import type { Graph, GraphNode } from "./graph";
import type { BodySchema } from "./structured-body";

type Registry = {
  types: Pick<
    Graph["types"][number],
    "id" | "title" | "category" | "archived"
  >[];
  nodes: Pick<Graph["nodes"][number], "id" | "title" | "typeId" | "archived">[];
  edges: Pick<
    Graph["edges"][number],
    "id" | "typeId" | "fromId" | "toId" | "archived"
  >[];
};
export type BodyReferenceCheck = {
  kind: "graph" | "binding";
  path: string;
  label: string;
  status: "resolved" | "missing";
  detail: string;
  nodeIds: string[];
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function indexGraph(graph: Registry) {
  const types = new Map(
    graph.types.filter((t) => !t.archived).map((t) => [t.id, t]),
  );
  const nodes = new Map(
    graph.nodes
      .filter((n) => !n.archived && types.has(n.typeId))
      .map((n) => [n.id, n]),
  );
  const edges = graph.edges.filter(
    (e) =>
      !e.archived &&
      types.has(e.typeId) &&
      nodes.has(e.fromId) &&
      nodes.has(e.toId),
  );
  return { types, nodes, edges };
}
type Index = ReturnType<typeof indexGraph>;
function dereference(root: BodySchema, input: BodySchema): BodySchema {
  if (typeof input.$ref !== "string" || !input.$ref.startsWith("#/"))
    return input;
  let target: unknown = root;
  for (const part of input.$ref.slice(2).split("/"))
    target = object(target)[part.replaceAll("~1", "/").replaceAll("~0", "~")];
  return { ...object(target), ...input };
}
function reference(
  index: Index,
  value: unknown,
  field: BodySchema,
  path: string,
): BodyReferenceCheck[] {
  const category = field["x-wiki-reference"];
  if (
    !["node", "node-type", "edge-type"].includes(String(category)) ||
    typeof value !== "string"
  )
    return [];
  const target =
    category === "node" ? index.nodes.get(value) : index.types.get(value);
  const found =
    !!target &&
    (category === "node" ||
      ("category" in target &&
        target.category === (category === "node-type" ? "node" : "edge")));
  return [
    {
      kind: "graph",
      path,
      label:
        typeof field.title === "string"
          ? field.title
          : path.split("/").filter(Boolean).join(" / ").replaceAll("_", " "),
      status: found ? "resolved" : "missing",
      detail:
        found && target
          ? target.title
          : `Missing or archived ${category}: ${value}`,
      nodeIds: category === "node" && found ? [value] : [],
    },
  ];
}
function binding(
  value: unknown,
  field: BodySchema,
  path: string,
): BodyReferenceCheck[] {
  if (field["x-wiki-source-binding"] !== true) return [];
  const declared = typeof value === "string" && value.trim().length > 0;
  return [
    {
      kind: "binding",
      path,
      label: typeof field.title === "string" ? field.title : path,
      status: declared ? "resolved" : "missing",
      detail: declared
        ? `Declared: ${value}. Runtime access is not verified.`
        : "No executable source relation is bound.",
      nodeIds: [],
    },
  ];
}
function validHop(
  index: Index,
  hop: Record<string, unknown>,
  allowed: unknown[],
) {
  return (
    index.types.get(String(hop.edge_type_id))?.category === "edge" &&
    ["incoming", "outgoing"].includes(String(hop.direction)) &&
    allowed.length > 0 &&
    allowed.every((id) => index.types.get(String(id))?.category === "node")
  );
}
function nextNodes(
  index: Index,
  current: Set<string>,
  hop: Record<string, unknown>,
  allowed: unknown[],
) {
  const next = new Set<string>();
  for (const edge of index.edges) {
    if (edge.typeId !== hop.edge_type_id) continue;
    const from = hop.direction === "incoming" ? edge.toId : edge.fromId;
    const to = hop.direction === "incoming" ? edge.fromId : edge.toId;
    if (current.has(from) && allowed.includes(index.nodes.get(to)?.typeId))
      next.add(to);
  }
  return next;
}
function walkPath(index: Index, nodeId: string, hops: unknown[]) {
  let current = new Set(index.nodes.has(nodeId) ? [nodeId] : []);
  if (!hops.length) return { current, broken: "No relationship path defined" };
  for (let i = 0; i < hops.length; i++) {
    const hop = object(hops[i]);
    const allowed = Array.isArray(hop.target_type_ids)
      ? hop.target_type_ids
      : [];
    if (!validHop(index, hop, allowed))
      return {
        current,
        broken: `Unresolved relationship or endpoint type at step ${i + 1}`,
      };
    current = nextNodes(index, current, hop, allowed);
    if (!current.size)
      return {
        current,
        broken: `Missing ${index.types.get(String(hop.edge_type_id))?.title} connection at step ${i + 1}`,
      };
  }
  return { current, broken: "" };
}
function pathCheck(
  index: Index,
  nodeId: string,
  value: unknown,
  path: string,
): BodyReferenceCheck {
  const rule = object(value);
  const result = walkPath(
    index,
    nodeId,
    Array.isArray(rule.path) ? rule.path : [],
  );
  const minimum = typeof rule.min_matches === "number" ? rule.min_matches : 1;
  const found = !result.broken && result.current.size >= minimum;
  return {
    kind: "graph",
    path,
    label: typeof rule.name === "string" ? rule.name : path,
    status: found ? "resolved" : "missing",
    detail:
      result.broken ||
      `${result.current.size} distinct matches; requires ${minimum}`,
    nodeIds: result.broken ? [] : [...result.current],
  };
}
function children(
  value: unknown,
  field: BodySchema,
): [string, unknown, BodySchema][] {
  if (Array.isArray(value))
    return value.map((item, i) => [String(i), item, object(field.items)]);
  const properties = object(field.properties);
  return Object.entries(object(value)).map(([key, item]) => [
    key,
    item,
    object(properties[key] ?? field.additionalProperties),
  ]);
}
/** Explicit schema annotations only; incomplete draft plans remain saveable. */
export function bodyGraphReferences(
  graph: Registry,
  node: Pick<GraphNode, "id" | "body">,
  schema?: BodySchema,
): BodyReferenceCheck[] {
  if (!schema) return [];
  let body: unknown;
  try {
    body = JSON.parse(node.body);
  } catch {
    return [];
  }
  const index = indexGraph(graph);
  function visit(
    value: unknown,
    input: BodySchema,
    path: string,
    depth: number,
  ): BodyReferenceCheck[] {
    if (depth > 32) return [];
    const field = dereference(schema ?? {}, input);
    if (field["x-wiki-graph-path"] === true)
      return [pathCheck(index, node.id, value, path)];
    return [
      ...reference(index, value, field, path),
      ...binding(value, field, path),
      ...children(value, field).flatMap(([key, item, child]) =>
        visit(item, child, `${path}/${key}`, depth + 1),
      ),
    ];
  }
  return visit(body, schema, "", 0);
}

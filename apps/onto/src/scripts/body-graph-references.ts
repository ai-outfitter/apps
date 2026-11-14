import { bodyGraphReferences } from "../lib/body-graph-references";
import type { Graph, GraphNode } from "../lib/graph";
import { el, entityUrl } from "./data";

export function bodyReferencePanel(graph: Graph, node: GraphNode) {
  const schema = graph.types.find((t) => t.id === node.typeId)?.jsonSchema;
  const checks = bodyGraphReferences(graph, node, schema);
  if (!checks.length) return null;
  const graphChecks = checks.filter((check) => check.kind === "graph");
  const bindings = checks.filter((check) => check.kind === "binding");
  const missing = graphChecks.filter(
    (check) => check.status === "missing",
  ).length;
  return el(
    "section",
    { class: "graph-record-properties", "aria-label": "Graph requirements" },
    el("h2", {}, "Graph requirements"),
    el(
      "p",
      { role: "status" },
      missing
        ? `${missing} unresolved graph requirement${missing === 1 ? "" : "s"}`
        : "All declared graph requirements resolve",
    ),
    el(
      "p",
      {},
      "Checks the records currently visible in this Wiki. Resolved graph links do not establish source access, evidence coverage or an active evaluator.",
    ),
    el(
      "ul",
      {},
      ...graphChecks.map((check) =>
        el(
          "li",
          {},
          `${check.status === "resolved" ? "Resolved" : "Missing"}: ${check.label} — ${check.detail}`,
          ...check.nodeIds
            .filter((id) => graph.nodes.some((n) => n.id === id))
            .map((id) =>
              el(
                "a",
                { href: entityUrl(id) },
                ` ${graph.nodes.find((n) => n.id === id)!.title}`,
              ),
            ),
        ),
      ),
    ),
    ...(bindings.length
      ? [
          el("h3", {}, "Source bindings"),
          el(
            "ul",
            {},
            ...bindings.map((check) =>
              el(
                "li",
                {},
                `${check.status === "missing" ? "Unbound" : "Declared"}: ${check.label} — ${check.detail}`,
              ),
            ),
          ),
        ]
      : []),
  );
}

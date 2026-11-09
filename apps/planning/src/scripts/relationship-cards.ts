import {
  createKnowledgeGraphViewer,
  type KnowledgeGraphData,
} from "@ai-outfitter/ui/knowledge-graph";
import { typeSegment } from "@ai-outfitter/app-sdk/graph-client";
import { wikiHref, type WikiContext } from "./wiki-context";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
// appendChild avoids the Workers HTMLRewriter Element.append overload.
function append(parent: Node, ...children: Node[]) {
  for (const child of children) parent.appendChild(child);
}
export type RelationshipGraph = {
  nodes: EntityRecord[];
  edges: EntityRecord[];
  types: EntityRecord[];
};
const el = (tag: string, text = "", className = "") => {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
};
export function relationshipSummary(
  record: EntityRecord,
  graph?: RelationshipGraph,
  projectName?: string,
  includeHeading = true,
) {
  const summary = document.createDocumentFragment();
  if (includeHeading) append(summary, el("h2", record.title));
  append(summary, el("p", String(record.attributes.summary || "")));
  const related = (graph?.edges ?? []).flatMap((edge) => {
    const { fromId, toId } = edge.attributes;
    const id =
      fromId === record.ref.id ? toId : toId === record.ref.id ? fromId : null;
    const node = graph?.nodes.find((node) => node.ref.id === id);
    if (!node) return [];
    const type = graph?.types.find(
      (type) => type.ref.id === node.attributes.typeId,
    );
    return [
      {
        node,
        kind: String(type?.title || type?.attributes.name || "Related record"),
      },
    ];
  });
  const priority = (kind: string) =>
    /customer.?segment/i.test(kind)
      ? 0
      : /use.?case/i.test(kind)
        ? 1
        : /project/i.test(kind)
          ? 2
          : 3;
  related.sort(
    (a, b) =>
      priority(a.kind) - priority(b.kind) ||
      a.node.title.localeCompare(b.node.title),
  );
  const pills = el("div", "", "planning-pills");
  if (projectName) append(pills, el("span", projectName, "planning-pill"));
  for (const { node, kind } of related.slice(0, 4)) {
    append(pills, el("span", `${kind}: ${node.title}`, "planning-pill"));
  }
  append(summary, pills);
  return summary;
}

function relationshipContent(
  record: EntityRecord,
  graph?: RelationshipGraph,
  wiki?: WikiContext,
) {
  const detail = document.createDocumentFragment();
  append(detail, el("h3", "Knowledge graph"));
  const graphView = el("div");
  graphView.setAttribute("role", "group");
  graphView.setAttribute("aria-label", `Relationships for ${record.title}`);
  const anchor = {
    id: record.ref.id,
    title: record.title,
    typeId: String(record.attributes.typeId ?? ""),
  };
  const edges = (graph?.edges ?? []).filter(
    (edge) =>
      edge.attributes.fromId === anchor.id ||
      edge.attributes.toId === anchor.id,
  );
  const ids = new Set([
    anchor.id,
    ...edges.flatMap((edge) => [
      String(edge.attributes.fromId),
      String(edge.attributes.toId),
    ]),
  ]);
  const nodes = new Map(
    (graph?.nodes ?? [])
      .filter((node) => ids.has(node.ref.id))
      .map((node) => [
        node.ref.id,
        {
          id: node.ref.id,
          title: node.title,
          typeId: String(node.attributes.typeId ?? ""),
        },
      ]),
  );
  nodes.set(anchor.id, anchor);
  const data: KnowledgeGraphData = {
    nodes: [...nodes.values()],
    edges: edges
      .filter(
        (edge) =>
          nodes.has(String(edge.attributes.fromId)) &&
          nodes.has(String(edge.attributes.toId)),
      )
      .map((edge) => ({
        id: edge.ref.id,
        typeId: String(edge.attributes.typeId ?? ""),
        fromId: String(edge.attributes.fromId),
        toId: String(edge.attributes.toId),
        properties: (edge.attributes.properties ?? {}) as Record<
          string,
          unknown
        >,
      })),
    types: (graph?.types ?? []).map((type) => ({
      id: type.ref.id,
      title: type.title,
      name: String(type.attributes.name ?? ""),
    })),
  };
  append(
    graphView,
    createKnowledgeGraphViewer(data, data, anchor, {
      nodeHref(id) {
        const node = nodes.get(id);
        const type = data.types.find((type) => type.id === node?.typeId);
        const kind =
          type?.name === "Problem"
            ? "opportunities"
            : type?.name === "CustomerSegment"
              ? "customer-segments"
              : undefined;
        const mount =
          /^(.*)\/(?:opportunities|customer-segments|use-cases)(?:\/[^/]+)?\/?$/.exec(
            location.pathname,
          )?.[1] ?? "";
        if (kind) return `${mount}/${kind}/${encodeURIComponent(id)}`;
        return wiki
          ? wikiHref(
              wiki,
              `${type ? typeSegment(type.name) : "entities"}/${encodeURIComponent(id)}`,
            )
          : location.href;
      },
    }),
  );
  append(detail, graphView);
  if (!data.edges.length)
    append(detail, el("p", "No relationships recorded yet.", "muted"));
  return detail;
}

export function relationshipDetails(
  record: EntityRecord,
  graph?: RelationshipGraph,
  wiki?: WikiContext,
) {
  const detail = el("div", "", "planning-card-detail");
  append(detail, relationshipContent(record, graph, wiki));
  return detail;
}

export function relationshipCard(
  record: EntityRecord,
  graph?: RelationshipGraph,
  projectName?: string,
  wiki?: WikiContext,
) {
  const card = document.createElement("details");
  card.className = "planning-card";
  const summary = document.createElement("summary");
  append(
    summary,
    relationshipSummary(record, graph, projectName),
    el("span", "Explore relationships", "planning-card-hint"),
  );
  const detail = el("div", "", "planning-card-detail");
  let arranged = false;
  card.addEventListener("toggle", () => {
    if (!card.open || arranged) return;
    arranged = true;
    detail.insertBefore(
      relationshipContent(record, graph, wiki),
      detail.firstChild,
    );
  });
  append(card, summary, detail);
  return { card, detail };
}

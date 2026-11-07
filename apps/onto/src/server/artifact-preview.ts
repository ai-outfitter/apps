import { z } from "zod";
import {
  defineAction,
  type ActionContext,
} from "@ai-outfitter/app-sdk/actions";
import { readGraph, type Database } from "./graph";
import {
  exploreKnowledgeGraph,
  loadKnowledgeGraph,
} from "../lib/knowledge-graphs";
import { entityRef, type EntityRecord } from "@ai-outfitter/app-sdk/entities";
import type { Graph, GraphNode } from "../lib/graph";

export const artifactInput = z.strictObject({
  anchorId: z.uuid(),
  definitionId: z.uuid(),
  selectedNodeIds: z.array(z.uuid()).min(1).max(200).optional(),
  provenance: z
    .strictObject({
      nodeIds: z.array(z.uuid()).max(100),
      relationships: z
        .array(z.strictObject({ fromId: z.uuid(), typeId: z.uuid() }))
        .max(101),
    })
    .optional(),
});
const mapping = z.strictObject({
  title: z.string().min(1).max(300),
  types: z.array(z.string().min(1)).min(1),
  mode: z.enum(["links", "summaries", "fields"]).default("summaries"),
  fields: z.array(z.string().min(1)).max(30).default([]),
});
const recipe = z.object({
  outputTitle: z.string().min(1),
  sections: z.array(z.string()).min(1),
  status: z.string(),
  sectionMappings: z.array(mapping).max(20).optional(),
});
const escapeMarkdown = (value: string) =>
  value.replace(/[\r\n]+/g, " ").replace(/[\\[\]`*_<>#]/g, "\\$&");
const quoteData = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function boundedResponse<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 500 * 1024)
    throw new Response(
      "Artifact response exceeds 500 KiB; narrow the selected scope or source content",
      { status: 413 },
    );
  return value;
}
function body(node: GraphNode): Record<string, unknown> {
  try {
    const value = JSON.parse(node.body);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}
function renderNodeFields(node: GraphNode, section: z.infer<typeof mapping>) {
  const lines: string[] = [];
  if (section.mode === "summaries" && node.summary)
    lines.push(quoteData(node.summary));
  if (section.mode === "fields")
    for (const key of section.fields) {
      const value = body(node)[key] ?? node.properties[key];
      if (value !== undefined)
        lines.push(
          quoteData(
            `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
          ),
        );
    }
  return lines;
}
function renderLines(
  template: z.infer<typeof recipe>,
  nodes: GraphNode[],
  edges: Graph["edges"],
  typeName: (id: string) => string | undefined,
  installationId: string,
) {
  const link = (node: GraphNode) =>
    `${escapeMarkdown(node.title)} (entity reference: ${JSON.stringify({ installationId, type: "graph-node", id: node.id })})`;
  // Older recipes have human-readable section names only. Preserve them and render
  // a neutral linked source list rather than guessing semantic mappings from prose.
  const sections =
    template.sectionMappings ??
    template.sections.map((title) => ({
      title,
      types: [],
      mode: "links" as const,
      fields: [],
    }));
  const lines = [
    `# ${escapeMarkdown(template.outputTitle)}`,
    "",
    `Definition status: ${escapeMarkdown(template.status)}. Context describes intent; links do not establish approval or delivery.`,
    "",
  ];
  for (const section of sections) {
    lines.push(`## ${escapeMarkdown(section.title)}`, "");
    const members = section.types.length
      ? nodes.filter((n) => section.types.includes(typeName(n.typeId) ?? ""))
      : [];
    if (!members.length) lines.push("No mapped records in this section.", "");
    for (const node of members) {
      lines.push(
        `- ${link(node)}${node.properties.status ? ` (${escapeMarkdown(String(node.properties.status))})` : ""}`,
      );
      lines.push(...renderNodeFields(node, section));
    }
    lines.push("");
  }
  lines.push(
    "## Source context",
    "",
    ...nodes.map(
      (n) =>
        `- ${link(n)} — revision ${n.revision}${n.summary ? `: ${escapeMarkdown(n.summary)}` : ""}`,
    ),
  );
  lines.push(
    "",
    "## Relationships",
    "",
    ...edges.map((edge) => {
      const from = nodes.find((n) => n.id === edge.fromId)!,
        to = nodes.find((n) => n.id === edge.toId)!;
      return `- ${link(from)} → ${escapeMarkdown(typeName(edge.typeId) ?? "relationship")} → ${link(to)}${edge.properties.status ? ` (${escapeMarkdown(String(edge.properties.status))})` : ""}${edge.body ? `\n${quoteData(edge.body)}` : ""}`;
    }),
  );
  return lines;
}
function scopedGraph(
  graph: Graph,
  anchor: GraphNode,
  selectedNodeIds: string[] | undefined,
): Graph {
  if (!selectedNodeIds) return graph;
  const ids = new Set([...selectedNodeIds, anchor.id]);
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => ids.has(node.id)),
    edges: graph.edges.filter(
      (edge) => ids.has(edge.fromId) && ids.has(edge.toId),
    ),
  };
}
/** The saved lens bounds selection. The recipe controls presentation, never authority. */
export function renderArtifact(
  graph: Graph,
  input: z.infer<typeof artifactInput>,
  installationId = "wiki",
) {
  const active = graph.nodes.filter((n) => !n.archived);
  const typeName = (id: string) =>
    graph.types.find((t) => t.id === id && !t.archived)?.name;
  const anchor = active.find((n) => n.id === input.anchorId);
  const definition = active.find(
    (n) =>
      n.id === input.definitionId &&
      typeName(n.typeId) === "ArtifactDefinition",
  );
  if (!anchor || !definition)
    throw new Response("Artifact anchor or definition not found", {
      status: 404,
    });
  const attached = graph.edges.some(
    (e) =>
      !e.archived &&
      e.fromId === definition.id &&
      e.toId === anchor.id &&
      typeName(e.typeId) === "artifact_for",
  );
  if (!attached)
    throw new Response("Definition is not attached to this subject", {
      status: 409,
    });
  const lenses = graph.edges
    .filter(
      (e) =>
        !e.archived &&
        e.fromId === definition.id &&
        typeName(e.typeId) === "uses_view",
    )
    .map((e) =>
      active.find(
        (n) => n.id === e.toId && typeName(n.typeId) === "KnowledgeGraph",
      ),
    )
    .filter((n): n is GraphNode => !!n);
  if (lenses.length !== 1)
    throw new Response(
      "Definition requires one unambiguous KnowledgeGraph lens",
      { status: 409 },
    );
  let selection;
  try {
    const lens = loadKnowledgeGraph(graph, lenses[0]);
    if (anchor.typeId !== lens.rootType)
      throw new Error("Lens root type does not match subject");
    selection = exploreKnowledgeGraph(
      scopedGraph(graph, anchor, input.selectedNodeIds),
      anchor,
      lens,
    );
  } catch (error) {
    throw new Response(
      error instanceof Error ? error.message : "Invalid lens",
      { status: 409 },
    );
  }
  if (selection.truncated)
    throw new Response("Graph selection exceeds 200 nodes; narrow the lens", {
      status: 409,
    });
  const selectedIds = new Set(
    input.selectedNodeIds ?? selection.nodes.map((n) => n.id),
  );
  selectedIds.add(anchor.id);
  const nodes = selection.nodes
    .filter((n) => selectedIds.has(n.id))
    .sort((a, b) => compare(a.id, b.id));
  const edges = selection.edges
    .filter((e) => selectedIds.has(e.fromId) && selectedIds.has(e.toId))
    .sort((a, b) => compare(a.id, b.id));
  let template;
  try {
    template = recipe.parse(body(definition));
  } catch {
    throw new Response("Artifact definition needs a valid structured recipe", {
      status: 409,
    });
  }
  if (template.status === "retired")
    throw new Response(
      "Artifact definition is retired; choose a current recipe",
      { status: 409 },
    );
  const lines = renderLines(template, nodes, edges, typeName, installationId);
  const attachments = graph.edges.filter(
    (e) =>
      !e.archived &&
      e.fromId === definition.id &&
      (e.toId === anchor.id || e.toId === lenses[0].id) &&
      ["artifact_for", "uses_view"].includes(String(typeName(e.typeId))),
  );
  const provenanceNodes = active.filter((node) =>
    input.provenance?.nodeIds.includes(node.id),
  );
  const provenanceEdges = graph.edges.filter(
    (edge) =>
      !edge.archived &&
      input.provenance?.relationships.some(
        (selector) =>
          selector.fromId === edge.fromId && selector.typeId === edge.typeId,
      ),
  );
  const sourceNodes = [...nodes, definition, lenses[0], ...provenanceNodes];
  const sourceEdges = [...edges, ...attachments, ...provenanceEdges];
  const sourceTypes = graph.types.filter(
    (t) =>
      !t.archived &&
      [...sourceNodes, ...sourceEdges].some((row) => row.typeId === t.id),
  );
  function record(
    type: string,
    row: { id: string; revision: number; title: string },
  ): EntityRecord {
    return {
      ref: { installationId, type, id: row.id },
      revision: row.revision,
      title: row.title || row.id,
      attributes: JSON.parse(JSON.stringify(row)),
      references:
        "source" in row && row.source ? [entityRef.parse(row.source)] : [],
    };
  }
  const sources = [
    ...sourceNodes.map((n) => record("graph-node", n)),
    ...sourceEdges.map((e) => record("graph-edge", e)),
    ...sourceTypes.map((t) => record("graph-type", t)),
  ];
  const unique = [
    ...new Map(
      sources.map((row) => [`${row.ref.type}/${row.ref.id}`, row]),
    ).values(),
  ].sort((a, b) =>
    compare(`${a.ref.type}/${a.ref.id}`, `${b.ref.type}/${b.ref.id}`),
  );
  return boundedResponse({
    title: template.outputTitle,
    description: lines.join("\n"),
    nodes: nodes.map((n) => ({ id: n.id, revision: n.revision })),
    edges: edges.map((e) => ({ id: e.id, revision: e.revision })),
    definition: { id: definition.id, revision: definition.revision },
    lens: { id: lenses[0].id, revision: lenses[0].revision },
    provenance: [
      ...provenanceNodes.map((n) => ({
        type: "graph-node",
        id: n.id,
        revision: n.revision,
      })),
      ...provenanceEdges.map((e) => ({
        type: "graph-edge",
        id: e.id,
        revision: e.revision,
      })),
    ].sort((a, b) => compare(`${a.type}/${a.id}`, `${b.type}/${b.id}`)),
    manifest: { sources: unique },
    gaps: [
      ...(template.sectionMappings
        ? []
        : [
            "Definition has descriptive sections only; add sectionMappings for structured section rendering.",
          ]),
      ...(template.status !== "implemented"
        ? [
            `Artifact recipe is ${template.status}; preview does not establish approval or delivery.`,
          ]
        : []),
    ],
  });
}
export const artifactActions = {
  "artifact.preview": defineAction({
    description:
      "Render a bounded saved KnowledgeGraph using an attached ArtifactDefinition. Read-only; no execution or snapshot is created.",
    access: "read",
    input: artifactInput,
    output: z.json(),
    run: async (context: ActionContext & { db: () => Database }, input) =>
      renderArtifact(
        await readGraph(context.db(), context.identity),
        input,
        context.identity.installationId,
      ),
  }),
};

import { z } from "zod";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
export const discoveryKind = z.enum([
  "opportunities",
  "customer-segments",
  "use-cases",
]);
const typeNames = {
  opportunities: "Problem",
  "use-cases": "UseCase",
  "customer-segments": "CustomerSegment",
} as const;
/** Planning presents the Wiki's existing definitions and records, without copying them. */
export async function listDiscovery(
  host: WorkflowHost<"interactive">,
  kind: z.infer<typeof discoveryKind>,
) {
  const { wiki, types, nodes, edges } = await readWikiGraph(host);
  const type = types.find(
    (row) =>
      row.attributes.name === typeNames[kind] &&
      row.attributes.category === "node" &&
      !row.attributes.archived,
  );
  if (!type)
    throw new Response(`Wiki type ${typeNames[kind]} is unavailable`, {
      status: 409,
    });
  const records = nodes.filter(
    (row) => row.attributes.typeId === type.ref.id && !row.attributes.archived,
  );
  const visibleNodes = nodes.filter((row) => !row.attributes.archived);
  const visibleIds = new Set(visibleNodes.map((row) => row.ref.id));
  const recordIds = new Set(records.map((row) => row.ref.id));
  const relatedEdges = edges.filter(
    (row) =>
      !row.attributes.archived &&
      visibleIds.has(String(row.attributes.fromId)) &&
      visibleIds.has(String(row.attributes.toId)) &&
      (recordIds.has(String(row.attributes.fromId)) ||
        recordIds.has(String(row.attributes.toId))),
  );
  const relatedIds = new Set([
    ...recordIds,
    ...relatedEdges.flatMap((row) => [
      String(row.attributes.fromId),
      String(row.attributes.toId),
    ]),
  ]);
  return {
    wiki,
    graph: {
      nodes: visibleNodes.filter((row) => relatedIds.has(row.ref.id)),
      edges: relatedEdges,
      types: types.filter((row) => !row.attributes.archived),
    },
    records: records.sort((a, b) => a.title.localeCompare(b.title)),
  };
}

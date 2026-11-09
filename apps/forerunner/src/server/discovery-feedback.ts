import { z } from "zod";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { Database } from "./items";
import { getPreview, updatePreview, type Preview } from "./discovery";
import type { Graph } from "./semantic-discovery";

export const evaluationInput = z.strictObject({
  previewId: z.uuid(),
  requestId: z.uuid(),
  rating: z.enum(["useful", "mixed", "not-useful"]),
  note: z.string().trim().max(4000).default(""),
});
export const correctionInput = z.strictObject({
  previewId: z.uuid(),
  requestId: z.uuid(),
  entryIndex: z.number().int().min(0),
  expectedId: z.uuid(),
  targetId: z.uuid(),
  note: z.string().trim().max(4000).default(""),
});
export const matchesInput = z.strictObject({
  previewId: z.uuid(),
  entryIndex: z.coerce.number().int().min(0),
  query: z.string().max(160).default(""),
});
type Host = WorkflowHost<"interactive">;
async function savedPreview(db: Database, who: AppIdentity, id: string) {
  requireEditor(who);
  const preview = await getPreview(db, who, id);
  if (!preview?.receipt)
    throw new Response("This run has not been saved.", { status: 409 });
  return preview;
}
function identity(preview: Preview, graph: Graph, index: number) {
  const entry = preview.entries[index];
  if (!entry || entry.kind === "Proposed relationship")
    throw new Response("Choose an entity match.", { status: 400 });
  const typeId =
    entry.typeId ??
    graph.types.find((t) => t.attributes.name === entry.kind)?.ref.id;
  const candidates = graph.nodes.filter(
    (n) => n.attributes.typeId === typeId && n.attributes.title === entry.title,
  );
  const id =
    entry.matchedId ??
    entry.id ??
    (candidates.length === 1 ? candidates[0].ref.id : undefined);
  const node = graph.nodes.find(
    (n) => n.ref.id === id && n.attributes.typeId === typeId,
  );
  if (!node)
    throw new Response(
      "This historical result has no unambiguous saved identity.",
      { status: 409 },
    );
  return { entry, node, typeId };
}
async function graphFor(host: Host, preview: Preview) {
  const graph = await readWikiGraph(host);
  if (!graph.wiki.writable) throw new Response("This Wiki is read-only.", {status:403});
  if (graph.wiki.installationId !== preview.wikiInstallationId)
    throw new Response("The run belongs to a different Wiki.", { status: 409 });
  return graph;
}
export async function evaluateRun(
  db: Database,
  who: AppIdentity,
  input: z.infer<typeof evaluationInput>,
) {
  const preview = await savedPreview(db, who, input.previewId);
  if (preview.evaluations?.some((e) => e.id === input.requestId))
    return preview;
  preview.evaluations = [
    ...(preview.evaluations ?? []),
    {
      id: input.requestId,
      at: new Date().toISOString(),
      rating: input.rating,
      note: input.note,
    },
  ].slice(-100);
  return updatePreview(db, who, preview);
}
export async function matchCandidates(
  db: Database,
  who: AppIdentity,
  host: Host,
  input: z.infer<typeof matchesInput>,
) {
  const preview = await savedPreview(db, who, input.previewId),
    graph = await graphFor(host, preview);
  const { node, typeId } = identity(preview, graph, input.entryIndex);
  const query = input.query.toLowerCase();
  return {
    currentId: node.ref.id,
    candidates: graph.nodes
      .filter(
        (n) =>
          n.attributes.typeId === typeId &&
          String(n.attributes.title).toLowerCase().includes(query),
      )
      .slice(0, 50)
      .map((n) => ({ id: n.ref.id, title: String(n.attributes.title) })),
  };
}
function unchangedEndpoints(
  edge: Graph["edges"][number] | undefined,
  from: unknown,
  to: unknown,
) {
  if (!edge || edge.attributes.fromId !== from || edge.attributes.toId !== to)
    throw new Response(
      "A related edge changed. Reload before correcting this match.",
      { status: 409 },
    );
  return edge;
}
function correctedEdges(
  preview: Preview,
  graph: Graph,
  fromId: string,
  targetId: string,
) {
  const mapping = new Map(
    preview.entries
      .filter((e) => e.id && e.matchedId)
      .map((e) => [e.id, e.matchedId]),
  );
  const operations: {
    operation: "update";
    type: "graph-edge";
    ref: string;
    id: string;
    revision: number;
    attributes: Record<string, string | boolean>;
  }[] = [];
  for (const original of preview.operations.filter(
    (o) => o.type === "graph-edge",
  )) {
    const expectedFrom =
      mapping.get(String(original.attributes.fromId)) ??
      original.attributes.fromId;
    const expectedTo =
      mapping.get(String(original.attributes.toId)) ?? original.attributes.toId;
    if (expectedFrom !== fromId && expectedTo !== fromId) continue;
    const edge = unchangedEndpoints(
      graph.edges.find((e) => e.ref.id === original.attributes.id),
      expectedFrom,
      expectedTo,
    );
    const from = expectedFrom === fromId ? targetId : String(expectedFrom),
      to = expectedTo === fromId ? targetId : String(expectedTo);
    if (from === to)
      throw new Response(
        "This correction would create a relationship to itself.",
        { status: 409 },
      );
    const duplicate = graph.edges.some(
      (e) =>
        e.ref.id !== edge.ref.id &&
        e.attributes.typeId === edge.attributes.typeId &&
        e.attributes.fromId === from &&
        e.attributes.toId === to,
    );
    operations.push({
      operation: "update",
      type: "graph-edge",
      ref: `$correction${operations.length}`,
      id: edge.ref.id,
      revision: edge.revision,
      attributes: duplicate ? { archived: true } : { fromId: from, toId: to },
    });
  }
  return operations;
}
export async function correctMatch(
  db: Database,
  who: AppIdentity,
  host: Host,
  input: z.infer<typeof correctionInput>,
) {
  const preview = await savedPreview(db, who, input.previewId);
  if (preview.evaluations?.some((e) => e.id === input.requestId))
    return preview;
  const graph = await graphFor(host, preview),
    { entry, node, typeId } = identity(preview, graph, input.entryIndex);
  if (node.ref.id !== input.expectedId)
    throw new Response("This match changed. Reload before correcting it.", {
      status: 409,
    });
  const target = graph.nodes.find(
    (n) => n.ref.id === input.targetId && n.attributes.typeId === typeId,
  );
  if (!target)
    throw new Response(
      "Choose an existing entity of the same type in this Wiki.",
      { status: 400 },
    );
  const operations = correctedEdges(preview, graph, node.ref.id, target.ref.id);
  if (operations.length)
    await host.call("actions.call", {
      installationId: preview.wikiInstallationId,
      action: "graph.apply",
      input: {
        requestKey: `forerunner-correction:${preview.id}:${input.requestId}`,
        operations,
      },
    });
  entry.id ??= node.ref.id;
  entry.typeId = typeId;
  entry.matchedId = target.ref.id;
  entry.matchedTitle = String(target.attributes.title);
  preview.evaluations = [
    ...(preview.evaluations ?? []),
    {
      id: input.requestId,
      at: new Date().toISOString(),
      rating: "corrected" as const,
      note: input.note,
      entryIndex: input.entryIndex,
      fromId: node.ref.id,
      targetId: target.ref.id,
    },
  ].slice(-100);
  return updatePreview(db, who, preview);
}

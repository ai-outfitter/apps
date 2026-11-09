import { storeType } from "../lib/type-metadata";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  requireEditor,
  sha256Hex,
  type AppIdentity,
} from "@ai-outfitter/app-sdk/server";
import {
  type Graph,
  typeInput,
  nodeInput,
  edgeInput,
  validateProperties,
} from "../lib/graph";
import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { readGraph } from "./graph";
import { guardedGraphBatch } from "./graph-batch";
import { requireOntologyValid } from "../lib/ontology-validation";
import { ontologyContext, v2 } from "../lib/ontology-model";
import { parseAssertion } from "../lib/ontology-records";

export const graphTransfer = z.strictObject({
  format: z.literal("outfitter-wiki-transfer-v1"),
  types: z.array(typeInput.extend({ id: z.uuid() })).max(200),
  nodes: z
    .array(
      nodeInput.extend({ id: z.uuid(), slug: nodeInput.shape.slug.unwrap(), revision: z.number().int().positive().optional() }),
    )
    .max(2000),
  edges: z.array(edgeInput.extend({ id: z.uuid(), revision: z.number().int().positive().optional() })).max(10000),
});

function unique<T>(rows: T[], key: (row: T) => unknown, label: string) {
  const seen = new Set();
  for (const row of rows) {
    const value = key(row);
    if (seen.has(value)) throw new Response(`Conflicting ${label}; reconcile before importing`, { status: 409 });
    seen.add(value);
  }
}

function comparable(row: object, schema: typeof typeInput | typeof nodeInput | typeof edgeInput) {
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(row).filter(([key]) => key in schema.shape)));
  if (!parsed.success) throw new Response("Stored record is incompatible; export and reconcile before importing.", { status: 409 });
  return JSON.stringify(parsed.data);
}

function additions<T extends { id: string }>(current: { id: string }[], incoming: T[], schema: typeof typeInput | typeof nodeInput | typeof edgeInput) {
  unique(incoming, row => row.id, "transfer ID");
  const existing = new Map(current.map(row => [row.id, row]));
  return incoming.filter(row => {
    const saved = existing.get(row.id);
    if (!saved) return true;
    if (comparable(saved, schema) !== comparable(row, schema)) throw new Response(`Existing record differs: ${row.id}. Export and reconcile before importing.`, { status: 409 });
    return false;
  });
}

function validateNodes(nodes: z.infer<typeof graphTransfer>["nodes"], types: Map<string, Graph["types"][number] | z.infer<typeof graphTransfer>["types"][number]>) {
  for (const node of nodes) {
    const type = types.get(node.typeId);
    if (!type || type.category !== "node") throw new Response("Unknown node type", { status: 400 });
    validateProperties(type, node.properties);
  }
}

function validateEdges(edges: z.infer<typeof graphTransfer>["edges"], types: Map<string, Graph["types"][number] | z.infer<typeof graphTransfer>["types"][number]>, nodes: Map<string, Graph["nodes"][number] | z.infer<typeof graphTransfer>["nodes"][number]>) {
  for (const edge of edges) {
    const type = types.get(edge.typeId);
    const from = nodes.get(edge.fromId), to = nodes.get(edge.toId);
    if (!type || type.category !== "edge" || !from || !to || edge.fromId === edge.toId) throw new Response("Invalid relationship type or endpoints", { status: 400 });
    validateProperties(type, edge.properties);
  }
}

function validateImportedPins(file: z.infer<typeof graphTransfer>, current: Graph) {
  const ctx = ontologyContext({ ...current, types: [...current.types, ...file.types] });
  const existing = new Map([...current.nodes, ...current.edges].map((row) => [row.id, row]));
  const incoming = new Map([...file.nodes, ...file.edges].map((row) => [row.id, row]));
  for (const node of file.nodes) {
    if (existing.has(node.id) || v2(ctx.contracts.get(node.typeId))?.stereotype !== "assertion") continue;
    const claim = parseAssertion(node);
    if (!claim.success) continue;
    const subject = claim.data.subject;
    const saved = existing.get(subject.id);
    const source = incoming.get(subject.id);
    if (saved && saved.revision !== (source?.revision ?? subject.revision))
      throw new Response(`Assertion subject revision differs: ${subject.id}; reconcile before importing.`, { status: 409 });
  }
}

function planGraph(file: z.infer<typeof graphTransfer>, current: Graph) {
  validateImportedPins(file, current);
  const types = additions(current.types, file.types, typeInput);
  const nodes = additions(current.nodes, file.nodes, nodeInput);
  const edges = additions(current.edges, file.edges, edgeInput);
  const allTypes = [...current.types, ...types], allNodes = [...current.nodes, ...nodes], allEdges = [...current.edges, ...edges];
  requireOntologyValid(current, {
    ...current, types: allTypes, nodes: allNodes, edges: allEdges,
  });
  validateNodes(nodes, new Map(allTypes.map(row => [row.id, row])));
  validateEdges(edges, new Map(allTypes.map(row => [row.id, row])), new Map(allNodes.map(row => [row.id, row])));
  unique(allTypes, row => row.name, "type name");
  unique(allNodes, row => row.slug, "node slug");

  return { types, nodes, edges };
}

/** Stable-ID, add-only transfer. Never replaces a record already in the destination. */
export async function restoreGraph(
  db: ReturnType<typeof installationDatabase>,
  who: AppIdentity,
  input: unknown,
  options: { preview?: boolean; previewToken?: string } = {},
) {
  requireEditor(who);
  const parsed = graphTransfer.safeParse(input);
  if (!parsed.success) throw new Response(parsed.error.message, { status: 400 });
  const file = parsed.data;
  const current = await readGraph(db, who);
  const { types, nodes, edges } = planGraph(file, current);
  const added = {
    types: types.length,
    nodes: nodes.length,
    edges: edges.length,
  };
  const previewToken = await sha256Hex(
    JSON.stringify({
      installationId: who.installationId,
      owner: who.owner,
      userId: who.userId,
      file,
      current,
    }),
  );
  if (options.preview)
    return {
      previewToken,
      destination: { installationId: who.installationId, owner: who.owner },
      conflictPolicy: "reject",
      added,
      unchanged: {
        types: file.types.length - types.length,
        nodes: file.nodes.length - nodes.length,
        edges: file.edges.length - edges.length,
      },
    };
  if (
    options.previewToken !== previewToken
  )
    throw new Response(
      "Import preview changed; preview this destination and file again",
      { status: 409 },
    );
  const now = Date.now();
  await guardedGraphBatch(db, who, current, [
      sql`INSERT INTO graph_types (id,category,name,title,body,properties,archived,revision,createdBy,updatedBy,createdAt,updatedAt)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.category'),json_extract(value,'$.name'),json_extract(value,'$.title'),json_extract(value,'$.body'),json_extract(value,'$.properties'),json_extract(value,'$.archived'),1,${who.userId},${who.userId},${now},${now} FROM json_each(${JSON.stringify(types.map(storeType))})`,
      sql`INSERT INTO graph_nodes (id,typeId,slug,title,summary,body,website,properties,archived,revision,createdBy,updatedBy,createdAt,updatedAt,validity)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.typeId'),json_extract(value,'$.slug'),json_extract(value,'$.title'),json_extract(value,'$.summary'),json_extract(value,'$.body'),json_extract(value,'$.website'),json_extract(value,'$.properties'),json_extract(value,'$.archived'),coalesce(json_extract(value,'$.revision'),1),${who.userId},${who.userId},${now},${now},json_extract(value,'$.validity') FROM json_each(${JSON.stringify(nodes)})`,
      sql`INSERT INTO graph_edges (id,typeId,fromId,toId,title,body,properties,archived,revision,createdBy,updatedBy,createdAt,updatedAt,validity)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.typeId'),json_extract(value,'$.fromId'),json_extract(value,'$.toId'),json_extract(value,'$.title'),json_extract(value,'$.body'),json_extract(value,'$.properties'),json_extract(value,'$.archived'),coalesce(json_extract(value,'$.revision'),1),${who.userId},${who.userId},${now},${now},json_extract(value,'$.validity') FROM json_each(${JSON.stringify(edges)})`,
  ], "Import preview changed; preview this destination and file again");
  return {
    added,
  };
}

/** Keep the full backup, but offer a portable graph without cross-app records. */
export function transferableGraph(graph: Graph) {
  const omittedNodes = graph.nodes.filter(node => node.source);
  const omittedIds = new Set(omittedNodes.map(node => node.id));
  const nodes = graph.nodes.filter(node => !omittedIds.has(node.id));
  const edges = graph.edges.filter(edge => !omittedIds.has(edge.fromId) && !omittedIds.has(edge.toId));
  const transferOmissions = { nodes: omittedNodes.map(node => node.id), edges: graph.edges.filter(edge => omittedIds.has(edge.fromId) || omittedIds.has(edge.toId)).map(edge => edge.id) };
  const transferLimitations = omittedNodes.length ? [`Portable transfer excludes ${omittedNodes.length} canonical app records and ${transferOmissions.edges.length} incident relationships. Relink them through their owning apps; the full backup retains them.`] : [];
  if (graph.types.length > 200 || nodes.length > 2000 || edges.length > 10000) return {
    transfer: null, transferOmissions,
    transferLimitations: [...transferLimitations, "This graph exceeds the single-import size limit; the full graph is retained in this backup."],
  };
  try {
    requireOntologyValid(graph, { ...graph, nodes, edges }, new Map(omittedNodes.map((node) => [node.id, "$omitted"])));
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    return { transfer: null, transferOmissions, transferLimitations: [...transferLimitations, "Omitting canonical app records would break ontology dependencies. Use the full backup and reconcile those dependencies through their owning apps before portable transfer."] };
  }
  const fields = (row: object, schema: typeof typeInput | typeof nodeInput | typeof edgeInput) => ({
    id: (row as { id: string }).id,
    ...(schema !== typeInput && "revision" in row ? { revision: row.revision } : {}),
    ...Object.fromEntries(Object.entries(row).filter(([key]) => key in schema.shape)),
  });
  const parsed = graphTransfer.safeParse({ format: "outfitter-wiki-transfer-v1", types: graph.types.map(row => fields(row, typeInput)), nodes: nodes.map(row => fields(row, nodeInput)), edges: edges.map(row => fields(row, edgeInput)) });
  if (!parsed.success) return { transfer: null, transferOmissions, transferLimitations: [...transferLimitations, "Some records do not match the portable transfer schema; the full graph is retained in this backup."] };
  return { transfer: parsed.data, transferOmissions, transferLimitations };
}

// A saved KnowledgeGraph as a GraphQL document. The JSON body holds a selection
// (rootTypes + selection), a saved query (query, hash, variables), or both: with a
// selection, `query` is what it compiles to (selectionDocument); without one, the
// query is the definition. Reads run the stored `query` when there is one and
// compile the selection only when it is absent.
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { nodeInput } from "@ai-outfitter/app-sdk/wiki";
import { graphqlNames, queryHash, selectionDocument, selectionQueryDepth, selectionVariables, type TypeRow } from "@ai-outfitter/app-sdk/graph-graphql";
import { definitionFromKnowledgeGraph, graphSelectionDefinition } from "@ai-outfitter/app-sdk/graph-selection";
import { isSavedQuery, knowledgeGraphDefinitionSchema } from "@ai-outfitter/app-sdk/knowledge-graph";
import { parse } from "graphql";
import { contextDefinition, parseKnowledgeGraph, resolveKnowledgeGraph } from "./knowledge-graphs";

/** Budgets for a selection read: deep enough for the 10 hops a definition may span. No static
 * field count: it counts every fragment use, so it grows exponentially with hops while the
 * work does not. The record (5,000), resolved-field (200,000) and byte budgets still apply. */
export const selectionReadBudget = { maxBytes: 4 * 1024 * 1024, maxDepth: selectionQueryDepth(10), maxFields: Number.POSITIVE_INFINITY };

type Body = { body?: unknown };
const bodyOf = (node: Body) => contextDefinition({ body: String(node.body ?? "") });

/** A KnowledgeGraph record's selection: its JSON-body selection, or legacy root_type + pattern
 * properties; null for a saved query without a selection. */
export function knowledgeGraphDefinition(record: EntityRecord) {
  const bounds = { id: `wiki:${record.ref.id}`, version: record.revision, maxNodes: 200 };
  const body = bodyOf(record.attributes);
  if (isSavedQuery(body)) return null;
  if (body?.selection)
    return graphSelectionDefinition.parse({ ...bounds, purpose: body.purpose, rootTypes: body.rootTypes, relationships: body.selection.relationships,
      maxDepth: body.selection.maxDepth, maxNodes: Math.min(bounds.maxNodes, body.selection.maxNodes),
      stopAtTypes: body.selection.stopAtTypes, stopAfterTypes: body.selection.stopAfterTypes });
  return definitionFromKnowledgeGraph(record, bounds);
}

/** The query a KnowledgeGraph body stores, with its variables schema. */
export function storedQuery(record: EntityRecord) {
  const body = bodyOf(record.attributes);
  return body?.query ? { query: body.query, variables: body.variables ?? selectionVariables } : null;
}

/** The operation a saved KnowledgeGraph's document is named after (its title, PascalCase). */
export const knowledgeGraphOperation = (record: EntityRecord) => graphqlNames.typeName(String(record.attributes.title ?? record.title ?? "")) || "KnowledgeGraph";

/** The `query`, `hash` and `variables` a KnowledgeGraph with a selection stores, compiled over these types. */
export function compiledQuery(record: EntityRecord, types: TypeRow[]) {
  const definition = knowledgeGraphDefinition(record);
  if (!definition) return null;
  const { query, variables } = selectionDocument(definition, types, { operationName: knowledgeGraphOperation(record) });
  return { query, hash: queryHash(query), variables };
}

/** A KnowledgeGraph node with a JSON-body selection, its stored `query`, `hash` and
 * `variables` set to what the selection compiles to over `types`. The stored document is
 * derived from the selection, so every write and every type change recompiles it
 * (server/knowledge-graph-refresh.ts); pages and agents then run it by hash. Any other
 * node, or a selection that does not compile, comes back unchanged. */
export function withCompiledQuery<T extends { id?: unknown; title?: unknown; body?: unknown; revision?: unknown }>(node: T, types: TypeRow[]): T {
  let body: Record<string, unknown>;
  try { body = JSON.parse(String(node.body ?? "")); } catch { return node; }
  if (!body || typeof body !== "object" || Array.isArray(body) || !body.selection) return node;
  const record = { ref: { installationId: "", type: "graph-node", id: String(node.id ?? "") }, revision: Number(node.revision ?? 1), title: String(node.title ?? ""), attributes: node } as unknown as EntityRecord;
  let compiled;
  try { compiled = compiledQuery(record, types); } catch { return node; }
  if (!compiled || (body.query === compiled.query && body.hash === compiled.hash)) return node;
  const next = { ...body, ...compiled };
  const nextBody = JSON.stringify(next);
  if (!nodeInput.shape.body.safeParse(nextBody).success || !knowledgeGraphDefinitionSchema.safeParse(next).success)
    throw new Response("Compiled KnowledgeGraph exceeds the node body limit", { status: 413 });
  return { ...node, body: nextBody };
}

/** Write-time check of a KnowledgeGraph node: a selection must resolve against the Wiki's
 * types, a query must parse and match its hash. */
export function validateKnowledgeGraph(graph: Parameters<typeof resolveKnowledgeGraph>[0], node: Body & { properties?: Record<string, unknown> }) {
  const body = bodyOf(node);
  if (body?.query) parse(body.query, { maxTokens: 10_000 });
  if (body?.query && body.hash && body.hash !== queryHash(body.query)) throw new Error("hash must be the sha256 hex of query; recompute it or leave it out");
  if (!isSavedQuery(body)) resolveKnowledgeGraph(graph, parseKnowledgeGraph(node as Parameters<typeof parseKnowledgeGraph>[0]));
}

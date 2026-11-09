import { readType, storeType } from "../lib/type-metadata";
import type { EntityRef } from "@ai-outfitter/app-sdk/entities";
import { appRecordKey, appRecordRef } from "@ai-outfitter/onto/contracts";
import {
  type AppIdentity,
  isUniqueViolation,
  requireEditor,
  requireEntityWriter,
} from "@ai-outfitter/app-sdk/server";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { recordHandle, type RecordKind } from "../lib/record-handles";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { z } from "zod";
import {
  core,
  type edgeInput,
  freeSlug,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type nodeInput,
  slugify,
  type TypeDefinition,
  type typeInput,
  validateProperties,
} from "../lib/graph";
import { graphEdges, graphNodes, graphTypes } from "./schema";
import { requireOntologyValid } from "../lib/ontology-validation";
import {
  parseKnowledgeGraph,
  resolveKnowledgeGraph,
} from "../lib/knowledge-graphs";
import type { TypeRow } from "@ai-outfitter/app-sdk/graph-graphql";
import { validateKnowledgeGraph, withCompiledQuery } from "../lib/knowledge-graph-document";
import { refreshKnowledgeGraphQueries } from "./knowledge-graph-refresh";

// biome-ignore lint/suspicious/noExplicitAny: shared asynchronous D1/libSQL interface.
export type Database = BaseSQLiteDatabase<"async", any>;
export type WriteContext = { verifiedReferences: boolean };
function fail(message: string, status = 400): never {
  throw new Response(message, { status });
}
function conflict(error: unknown): never {
  if (isUniqueViolation(error))
    fail("This record or relationship already exists", 409);
  throw error;
}
const audit = (who: AppIdentity) => ({
  updatedBy: who.userId,
  updatedAt: Date.now(),
});
const jsonOrNull = (value: unknown) => value == null ? null : JSON.stringify(value);
export function nodeView(row: typeof graphNodes.$inferSelect): GraphNode {
  const { externalKey, validity, ...node } = row;
  return { ...node, source: appRecordRef(externalKey), ...(validity ? { validity } : {}) };
}
export const edgeView = (row: typeof graphEdges.$inferSelect): GraphEdge => {
  const { validFrom, validTo, ...edge } = row;
  return { ...edge, ...(validFrom || validTo ? { validity: { from: validFrom, to: validTo } } : {}) };
};
export async function readGraph(
  db: Database,
  who: AppIdentity,
): Promise<Graph> {
  const [types, nodes, edges] = await Promise.all([
    db.select().from(graphTypes).orderBy(asc(graphTypes.name)),
    db.select().from(graphNodes).orderBy(asc(graphNodes.id)),
    db.select().from(graphEdges).orderBy(asc(graphEdges.id)),
  ]);
  return {
    types: types.map(readType),
    nodes: nodes.map(nodeView),
    edges: edges.map(edgeView),
    canEdit: who.canEdit,
  };
}
export async function getNode(db: Database, id: string) {
  const [row] = await db.select().from(graphNodes).where(eq(graphNodes.id, id));
  return row ? nodeView(row) : fail("Entity not found", 404);
}
export async function getEdge(db: Database, id: string) {
  const [row] = await db.select().from(graphEdges).where(eq(graphEdges.id, id));
  return row ? edgeView(row) : fail("Connection not found", 404);
}
export async function getType(db: Database, id: string) {
  const [row] = await db.select().from(graphTypes).where(eq(graphTypes.id, id));
  return row ? readType(row) : fail("Type not found", 404);
}
function requireType(
  types: TypeDefinition[],
  id: string,
  category: "node" | "edge",
) {
  return (
    types.find((t) => t.id === id && t.category === category && !t.archived) ??
    fail(`Choose an active ${category} type`)
  );
}
export function checkProperties(
  type: TypeDefinition,
  values: z.infer<typeof nodeInput>["properties"],
  types?: TypeDefinition[],
) {
  try {
    validateProperties(type, values);
    // The legacy root_type + pattern projection is optional (a saved query has none).
    if (type.id === core.knowledgeGraph && (values.pattern !== undefined || values.root_type !== undefined)) {
      const pattern = parseKnowledgeGraph({ properties: values });
      if (types) resolveKnowledgeGraph({ types }, pattern);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : "Invalid properties");
  }
}
export function noReferences(references: EntityRef[]) {
  if (references.length) fail("This record takes no app references");
}
function checkRecordId(id: string | undefined, currentId: string | undefined) {
  if (currentId && id && id !== currentId)
    fail("Record IDs are immutable", 409);
}

// Match the full validated snapshot in the write statement, including newly added
// records, so a concurrent writer cannot invalidate a graph-level constraint.
function matchesSnapshot(
    table: typeof graphTypes | typeof graphNodes | typeof graphEdges,
    rows: { id: string; revision: number }[],
    scope: SQL = sql`1`,
  ) {
  return sql`(select count(*) from ${table} where ${scope}) = ${rows.length} and not exists (
      select 1 from json_each(${JSON.stringify(rows.map(({ id, revision }) => ({ id, revision })))}) expected
      left join ${table} actual on actual.id = json_extract(expected.value, '$.id')
      where actual.id is null or actual.revision != json_extract(expected.value, '$.revision'))`;
}
export function graphUnchanged(graph: Graph) {
  return sql`${matchesSnapshot(graphTypes, graph.types)} and ${matchesSnapshot(graphNodes, graph.nodes)} and ${matchesSnapshot(graphEdges, graph.edges)}`;
}

/** Without contracts, preserve targeted entity-write concurrency. Always guard
 * all definitions so concurrent contract activation cannot bypass validation. */
export function entityGraphUnchanged(
  graph: Graph,
  scope: { typeId?: string; nodeIds?: string[]; edgeIds?: string[] } = {},
) {
  if (graph.types.some((type) => type.ontology !== undefined))
    return graphUnchanged(graph);
  const nodes = graph.nodes.filter((node) =>
    scope.typeId ? node.typeId === scope.typeId : scope.nodeIds?.includes(node.id),
  );
  const edges = graph.edges.filter((edge) =>
    scope.typeId ? edge.typeId === scope.typeId : scope.edgeIds?.includes(edge.id),
  );
  const nodeScope = scope.typeId
    ? sql`typeId = ${scope.typeId}`
    : sql`id IN (SELECT value FROM json_each(${JSON.stringify(scope.nodeIds ?? [])}))`;
  const edgeScope = scope.typeId
    ? sql`typeId = ${scope.typeId}`
    : sql`id IN (SELECT value FROM json_each(${JSON.stringify(scope.edgeIds ?? [])}))`;
  return sql`${matchesSnapshot(graphTypes, graph.types)} and ${matchesSnapshot(graphNodes, nodes, nodeScope)} and ${matchesSnapshot(graphEdges, edges, edgeScope)}`;
}

async function insertType(db: Database, row: TypeDefinition, graph: Graph) {
  const stored = storeType(row);
  const inserted = await db
    .insert(graphTypes)
    .select(
      sql`select ${stored.id}, ${stored.category}, ${stored.name}, ${stored.title}, ${stored.body}, ${JSON.stringify(stored.properties)}, ${Number(stored.archived)}, ${stored.seedVersion}, ${stored.revision}, ${stored.createdBy}, ${stored.updatedBy}, ${stored.createdAt}, ${stored.updatedAt} where ${entityGraphUnchanged(graph)}`,
    )
    .returning()
    .catch(conflict);
  if (!inserted[0]) fail("Graph changed; reload before saving", 409);
  return readType(inserted[0]);
}

export async function saveType(
  db: Database,
  who: AppIdentity,
  input: z.infer<typeof typeInput>,
  current?: TypeDefinition,
  revision?: number,
) {
  requireEditor(who);
  checkRecordId(input.id, current?.id);
  if (
    new Set(input.properties.map((p) => p.name)).size !==
    input.properties.length
  )
    fail("Property names must be unique");
  const row = {
    ...input,
    id: current?.id ?? input.id ?? crypto.randomUUID(),
    revision: (revision ?? 0) + 1,
    seedVersion: current?.seedVersion ?? null,
    createdBy: current?.createdBy ?? who.userId,
    createdAt: current?.createdAt ?? Date.now(),
    ...audit(who),
  };
  const graph = await readGraph(db, who);
  requireOntologyValid(
    graph,
    { ...graph, types: [...graph.types.filter((t) => t.id !== row.id), row] },
    new Map([[row.id, "$type"]]),
  );
  if (!current) {
    const inserted = await insertType(db, row, graph);
    await refreshKnowledgeGraphQueries(db);
    return inserted;
  }
  const nodes = graph.nodes.filter((n) => n.typeId === current.id),
    edges = graph.edges.filter((e) => e.typeId === current.id);
  if (
    (nodes.length && input.category !== "node") ||
    (edges.length && input.category !== "edge")
  )
    fail("The category must match the existing records");
  for (const record of [...nodes, ...edges])
    checkProperties(row, record.properties);
  const result = await db
    .update(graphTypes)
    .set(storeType(row))
    .where(
      and(
        eq(graphTypes.id, current.id),
        eq(graphTypes.revision, revision ?? 0),
        row.ontology !== undefined ? graphUnchanged(graph) : entityGraphUnchanged(graph, { typeId: current.id }),
      ),
    )
    .returning()
    .catch(conflict);
  if (!result[0]) fail("Type changed; reload before saving", 409);
  await refreshKnowledgeGraphQueries(db);
  return readType(result[0]);
}
function nodeSource(
  context: WriteContext,
  references: EntityRef[],
  current?: GraphNode,
) {
  if (references.length > 1)
    fail("An entity can document one canonical app record");
  const source = references[0] ?? null;
  const same =
    JSON.stringify(current?.source ?? null) === JSON.stringify(source);
  if (current?.source && !same) fail("Preserve the canonical app reference");
  if (!context.verifiedReferences && source && !same)
    fail(
      "Canonical references must be verified through the platform entity API",
      403,
    );
  return source;
}
/** A KnowledgeGraph input with its selection's document compiled over this Wiki's types, validated. */
function compiledKnowledgeGraph<T extends { id?: unknown; body?: unknown }>(graph: Parameters<typeof validateKnowledgeGraph>[0], input: T, currentId?: string): T {
  const next = { ...input, body: withCompiledQuery({ ...input, id: currentId ?? input.id }, graph.types as unknown as TypeRow[]).body };
  validateKnowledgeGraph(graph, next as never);
  return next;
}
export async function saveNode(
  db: Database,
  who: AppIdentity,
  context: WriteContext,
  input: z.infer<typeof nodeInput>,
  references: EntityRef[],
  current?: GraphNode,
  revision?: number,
) {
  requireEntityWriter(who);
  if (current && input.id && input.id !== current.id)
    fail("Record IDs are immutable", 409);
  const graph = await readGraph(db, who);
  const type = requireType(graph.types, input.typeId, "node");
  if (current && current.typeId !== input.typeId)
    fail("Keep the entity's type");
  checkProperties(type, input.properties, graph.types);
  if (type.id === core.knowledgeGraph) input = compiledKnowledgeGraph(graph, input, current?.id);
  const source = nodeSource(context, references, current);
  if (type.id === core.project && source && source.type !== "project")
    fail("A linked Project must reference a Planning project");
  const slug =
    input.slug ??
    current?.slug ??
    freeSlug(
      slugify(input.title),
      new Set(graph.nodes.filter((n) => n.typeId === type.id).map((n) => n.slug).filter((slug) => slug !== undefined)),
    );
  // An update never clears a key: accounts keep theirs, and a source cannot change.
  const row = {
    ...input,
    slug,
    ...(source ? { externalKey: appRecordKey(source) } : {}),
    ...audit(who),
    revision: (revision ?? 0) + 1,
  };
  const node = {
    ...row,
    source,
    id: current?.id ?? input.id ?? crypto.randomUUID(),
  };
  requireOntologyValid(
    graph,
    { ...graph, nodes: [...graph.nodes.filter((n) => n.id !== node.id), node] },
    new Map([[node.id, "$node"]]),
  );
  const condition = entityGraphUnchanged(graph, { nodeIds: [node.id] });
  if (current) {
    const result = await db
      .update(graphNodes)
      .set(row)
      .where(
        and(
          eq(graphNodes.id, current.id),
          eq(graphNodes.revision, revision ?? 0),
          condition,
        ),
      )
      .returning()
      .catch(conflict);
    return result[0]
      ? nodeView(result[0])
      : fail("Entity changed; reload before saving", 409);
  }
  const inserted = await db
    .insert(graphNodes)
    .select(
      sql`select ${node.id},${type.id},${slug},${row.title},${row.summary},${row.body},${row.website},${jsonOrNull(row.validity)},${JSON.stringify(row.properties)},${source ? appRecordKey(source) : null},${Number(row.archived)},1,${who.userId},${who.userId},${row.updatedAt},${row.updatedAt} where ${condition}`,
    )
    .returning()
    .catch(conflict);
  return inserted[0]
    ? nodeView(inserted[0])
    : fail("Graph changed; reload before saving", 409);
}
export async function saveEdge(
  db: Database,
  who: AppIdentity,
  input: z.infer<typeof edgeInput>,
  current?: GraphEdge,
  revision?: number,
) {
  requireEntityWriter(who);
  if (current && input.id && input.id !== current.id)
    fail("Record IDs are immutable", 409);
  const graph = await readGraph(db, who);
  const type = requireType(graph.types, input.typeId, "edge");
  const endpoint = (id: string) =>
    graph.nodes.find((n) => n.id === id && (input.archived || !n.archived));
  const from = endpoint(input.fromId),
    to = endpoint(input.toId);
  if (!from || !to) fail("Choose existing active entities");
  if (from.id === to.id) fail("Choose two different entities");
  checkProperties(type, input.properties);
  const row = { ...input, ...audit(who), revision: (revision ?? 0) + 1 };
  const edge = {
    ...row,
    id: current?.id ?? input.id ?? crypto.randomUUID(),
  };
  requireOntologyValid(
    graph,
    { ...graph, edges: [...graph.edges.filter((e) => e.id !== edge.id), edge] },
    new Map([[edge.id, "$edge"]]),
  );
  const condition = entityGraphUnchanged(graph, {
    nodeIds: [from.id, to.id], edgeIds: [edge.id],
  });
  if (current) {
    const result = await db
      .update(graphEdges)
      .set({ ...row, validFrom: row.validity?.from ?? null, validTo: row.validity?.to ?? null })
      .where(
        and(
          eq(graphEdges.id, current.id),
          eq(graphEdges.revision, revision ?? 0),
          condition,
        ),
      )
      .returning()
      .catch(conflict);
    return result[0] ? edgeView(result[0]) : fail("Connection changed; reload before saving", 409);
  }
  const inserted = await db
    .insert(graphEdges)
    .select(
      sql`select ${edge.id},${type.id},${from.id},${to.id},${row.title},${row.body},${JSON.stringify(row.properties)},${Number(row.archived)},1,${who.userId},${who.userId},${row.updatedAt},${row.updatedAt},${row.validity?.from ?? null},${row.validity?.to ?? null} where ${condition}`,
    )
    .returning()
    .catch(conflict);
  return inserted[0] ? edgeView(inserted[0]) : fail("Graph changed; reload before saving", 409);
}

/** Each committed operation's record as a handle (type name, node slug or edge
 * type:from:to) instead of its UUID, for answers agents read back. */
export async function withRecordHandles<T extends { operation: unknown; recordId: string | null }>(db: Database, operations: T[]) {
  const kindOf = (row: T) => (row.operation as { type?: RecordKind }).type;
  const ids = (kind: RecordKind) => [...new Set(operations.flatMap((row) => (row.recordId && kindOf(row) === kind ? [row.recordId] : [])))];
  const chunks = <V>(values: V[]) => Array.from({ length: Math.ceil(values.length / 90) }, (_, i) => values.slice(i * 90, i * 90 + 90));
  const edges = (await Promise.all(chunks(ids("graph-edge")).map((part) => db.select().from(graphEdges).where(inArray(graphEdges.id, part))))).flat();
  const nodeIds = [...new Set([...ids("graph-node"), ...edges.flatMap((edge) => [edge.fromId, edge.toId])])];
  const nodes = (await Promise.all(chunks(nodeIds).map((part) => db.select({ id: graphNodes.id, slug: graphNodes.slug }).from(graphNodes).where(inArray(graphNodes.id, part))))).flat();
  const types = operations.some((row) => row.recordId && kindOf(row) !== "graph-node")
    ? await db.select({ id: graphTypes.id, name: graphTypes.name }).from(graphTypes) : [];
  const handle = recordHandle({
    types: types as unknown as Graph["types"], nodes: nodes as unknown as Graph["nodes"], edges: edges as unknown as Graph["edges"],
  });
  return operations.map(({ recordId, ...row }) => {
    const kind = kindOf(row as T);
    return { ...row, record: recordId && kind ? handle(kind, recordId) : null };
  });
}

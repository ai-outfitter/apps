import { z } from "zod";
import { readType } from "../lib/type-metadata";
import {
  defineEntity,
  entityRef,
  type EntityProvider,
} from "@ai-outfitter/app-sdk/entities";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  or,
  sql,
  type AnyColumn,
  type SQLWrapper,
} from "drizzle-orm";
import { appRecordKey } from "@ai-outfitter/onto/contracts";
import {
  edgeInput,
  type GraphEdge,
  type GraphNode,
  nodeInput,
  type TypeDefinition,
  typeInput,
} from "../lib/graph";
import {
  type Database,
  edgeView,
  getEdge,
  getNode,
  getType,
  nodeView,
  noReferences,
  saveEdge,
  saveNode,
  saveType,
  type WriteContext,
} from "./graph";
import { organizationGoalsEntity } from "./organization-goals";
import { graphEdges, graphNodes, graphTypes } from "./schema";
import { edgeHandle } from "../lib/record-handles";

const textFilter = z.string().min(1).max(200);
const identifiers = z.array(textFilter).min(1).max(100);
const commonFilter = {
  query: z.string().trim().max(256).optional(),
  ids: identifiers.optional(),
  titleContains: textFilter.optional(),
  archived: z.boolean().optional(),
};
// D1 allows 100 bind parameters; pagination and scalar filters need room too.
function filterBinds(key: string, value: unknown) {
  if (value === undefined) return 0;
  if (Array.isArray(value)) return value.length * (key === "nodeIds" ? 2 : 1);
  return ({ query: 10, nodeId: 2 } as Record<string, number>)[key] ?? 1;
}
const filterBudget = (filter: Record<string, unknown>) => Object.entries(filter).reduce((count, [key, value]) => count + filterBinds(key, value), 0) <= 90;
const filterBudgetMessage = "Filter exceeds 90 query parameters; split into smaller batches";
const typeFilter = z.strictObject({
  ...commonFilter,
  name: textFilter.optional(),
  names: identifiers.optional(),
  category: z.enum(["node", "edge"]).optional(),
}).refine(filterBudget, filterBudgetMessage);
const nodeFilter = z.strictObject({
  ...commonFilter,
  typeId: textFilter.optional(),
  typeIds: identifiers.optional(),
  slug: textFilter.optional(),
  source: entityRef.optional(),
}).refine(filterBudget, filterBudgetMessage);
const edgeFilter = z.strictObject({
  ...commonFilter,
  typeId: textFilter.optional(),
  typeIds: identifiers.optional(),
  fromId: textFilter.optional(),
  fromTypeIds: identifiers.optional(),
  toId: textFilter.optional(),
  nodeId: textFilter.optional(),
  nodeIds: identifiers.optional(),
}).refine(filterBudget, filterBudgetMessage);
/** Literal, case-insensitive title substring: '%' and '_' have no wildcard meaning. */
const titleCondition = (column: SQLWrapper, value?: string) =>
  value === undefined
    ? undefined
    : sql`instr(lower(${column}), lower(${value})) > 0`;

const queryCondition = (columns: AnyColumn[], query?: string) => !query ? undefined : or(...columns.map(column => titleCondition(column, query)));

const among = (column: AnyColumn, values?: string[]) => values === undefined ? undefined : inArray(column, values);

const equals = (column: AnyColumn, value: string | boolean | undefined) =>
  value === undefined ? undefined : eq(column, value);

const nodesCondition = (ids?: string[]) => ids === undefined ? undefined : or(inArray(graphEdges.fromId, ids), inArray(graphEdges.toId, ids));

type Named = { handle?: string };
/** Edges with their handle (type name:from slug:to slug) for naming. */
async function named(db: Database, edges: GraphEdge[]) {
  if (!edges.length) return edges;
  const nodeIds = [...new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]))];
  const slugs = new Map<string, string>();
  for (let i = 0; i < nodeIds.length; i += 90)
    for (const row of await db.select({ id: graphNodes.id, slug: graphNodes.slug }).from(graphNodes).where(inArray(graphNodes.id, nodeIds.slice(i, i + 90)))) slugs.set(row.id, row.slug);
  const typeIds = [...new Set(edges.map((edge) => edge.typeId))];
  const types = new Map((await db.select({ id: graphTypes.id, name: graphTypes.name }).from(graphTypes).where(inArray(graphTypes.id, typeIds))).map((row) => [row.id, row.name]));
  return edges.map((edge): GraphEdge & Named => ({ ...edge, handle: edgeHandle(types.get(edge.typeId) ?? edge.typeId, slugs.get(edge.fromId) ?? edge.fromId, slugs.get(edge.toId) ?? edge.toId) }));
}

/** Published audit fields come from the same row as the record. */
function provenance(row: { createdBy: string | null; updatedBy: string | null; createdAt: number; updatedAt: number; seedVersion?: number | null }) {
  return { provenance: { createdBy: row.createdBy, updatedBy: row.updatedBy, createdAt: row.createdAt, updatedAt: row.updatedAt },
    ...("seedVersion" in row ? { seedVersion: row.seedVersion ?? null } : {}) };
}

export function graphEntities(
  db: Database,
  context: WriteContext,
): EntityProvider[] {
  const types = defineEntity<
    TypeDefinition,
    typeof typeInput,
    typeof typeFilter
  >({
    type: "graph-type",
    collection: "types",
    orderFields: ["id", "title", "name"],
    selectFields: ["id", ...Object.keys(typeInput.shape)],
    title: "Wiki type definition",
    description:
      "Documented node or directed relationship type. Definitions declare scalar properties, optional body jsonSchema and a versioned ontology contract. Relators declare participation; projections are read-only. Read that schema before authoring a structured node body. Existing records must remain valid when definitions change. Provenance and seedVersion are read-only. Archive unused definitions with archived:true. No semantic relationship grants authorization.",
    schema: typeInput,
    outputAttributes: provenance,
    filterSchema: typeFilter,
    name: (row) => row.title,
    list: async (_who, offset, limit, filter, order) => {
      const f = filter ?? {};
      return (
        await db
          .select()
          .from(graphTypes)
          .where(
            and(
              queryCondition([graphTypes.id, graphTypes.name, graphTypes.title, graphTypes.body, graphTypes.properties, graphTypes.category], f.query),
              titleCondition(graphTypes.title, f.titleContains),
              among(graphTypes.id, f.ids),
              equals(graphTypes.archived, f.archived),
              equals(graphTypes.name, f.name),
              among(graphTypes.name, f.names),
              equals(graphTypes.category, f.category),
            ),
          )
          .orderBy(order ? (order.direction === "desc" ? desc : asc)(order.field === "name" ? graphTypes.name : order.field === "title" ? graphTypes.title : graphTypes.id) : asc(graphTypes.id), asc(graphTypes.id))
          .offset(offset)
          .limit(limit)
      ).map(readType);
    },
    get: (_who, id) => getType(db, id),
    create: (who, input, references) => {
      noReferences(references);
      return saveType(db, who, input);
    },
    update: (who, current, input, revision, references) => {
      noReferences(references);
      return saveType(db, who, input, current, revision);
    },
  });
  const nodes = defineEntity<GraphNode, typeof nodeInput, typeof nodeFilter>({
    type: "graph-node",
    collection: "nodes",
    orderFields: ["id", "title"],
    selectFields: ["id", ...Object.keys(nodeInput.shape)],
    title: "Wiki graph node",
    description:
      "Typed node documenting an identifiable thing or relator. Create a complete relator with its participation links in graph.apply. Assertion nodes use the SDK assertionBody schema; authenticated confirmation is a separate receipt. Discover graph-type for permitted properties and the optional body jsonSchema. Structured bodies are JSON serialized into the body string. Projects may document external work without an app reference; optionally link a canonical Planning project. Read-only provenance records writers; no private contact fields or external identifiers are exposed. When updating a sourced node, include its current canonical reference. archived:true reversibly removes a node from active views.",
    schema: nodeInput,
    outputAttributes: provenance,
    filterSchema: nodeFilter,
    name: (row) => row.title,
    references: (row) => (row.source ? [row.source] : []),
    list: async (_who, offset, limit, filter, order) => {
      const f = filter ?? {};
      return (
        await db
          .select()
          .from(graphNodes)
          .where(
            and(
              queryCondition([graphNodes.id, graphNodes.title, graphNodes.slug, graphNodes.summary, graphNodes.body, graphNodes.properties, graphNodes.website], f.query),
              titleCondition(graphNodes.title, f.titleContains),
              among(graphNodes.id, f.ids),
              equals(graphNodes.archived, f.archived),
              equals(graphNodes.typeId, f.typeId),
              among(graphNodes.typeId, f.typeIds),
              equals(graphNodes.slug, f.slug),
              f.source === undefined ? undefined : eq(graphNodes.externalKey, appRecordKey(f.source)),
            ),
          )
          .orderBy(order ? (order.direction === "desc" ? desc : asc)(order.field === "title" ? graphNodes.title : graphNodes.id) : asc(graphNodes.id), asc(graphNodes.id))
          .offset(offset)
          .limit(limit)
      ).map(nodeView);
    },
    get: (_who, id) => getNode(db, id),
    create: (who, input, references) =>
      saveNode(db, who, context, input, references),
    update: (who, current, input, revision, references) =>
      saveNode(db, who, context, input, references, current, revision),
  });
  const edges = defineEntity<GraphEdge, typeof edgeInput, typeof edgeFilter>({
    type: "graph-edge",
    collection: "edges",
    orderFields: ["id", "title"],
    selectFields: ["id", ...Object.keys(edgeInput.shape)],
    title: "Wiki directed relationship",
    description:
      "Stored relationship with its own identity, revision, properties, narrative and read-only provenance. Use graph.relationships for direction-independent symmetric lookup and read-only derived views. Discover graph-type for meaning and property definitions. archived:true reversibly deletes a relationship.",
    schema: edgeInput,
    outputAttributes: provenance,
    filterSchema: edgeFilter,
    // An untitled edge is named by its handle (type:from:to), never its UUID.
    name: (row) => row.title || (row as Named).handle || row.id,
    list: async (_who, offset, limit, filter, order) => {
      const f = filter ?? {};
      return named(db, (
        await db
          .select()
          .from(graphEdges)
          .where(
            and(
              queryCondition([graphEdges.id, graphEdges.title, graphEdges.body, graphEdges.properties, graphEdges.typeId, graphEdges.fromId, graphEdges.toId], f.query),
              titleCondition(graphEdges.title, f.titleContains),
              among(graphEdges.id, f.ids),
              equals(graphEdges.archived, f.archived),
              equals(graphEdges.typeId, f.typeId),
              among(graphEdges.typeId, f.typeIds),
              equals(graphEdges.fromId, f.fromId),
              f.fromTypeIds === undefined ? undefined : inArray(graphEdges.fromId,
                db.select({ id: graphNodes.id }).from(graphNodes).where(inArray(graphNodes.typeId, f.fromTypeIds))),
              equals(graphEdges.toId, f.toId),
              nodesCondition(f.nodeIds),
              f.nodeId === undefined
                ? undefined
                : or(
                    eq(graphEdges.fromId, f.nodeId),
                    eq(graphEdges.toId, f.nodeId),
                  ),
            ),
          )
          .orderBy(order ? (order.direction === "desc" ? desc : asc)(order.field === "title" ? graphEdges.title : graphEdges.id) : asc(graphEdges.id), asc(graphEdges.id))
          .offset(offset)
          .limit(limit)
      ).map(edgeView));
    },
    get: async (_who, id) => { const edge = await getEdge(db, id); return edge ? (await named(db, [edge]))[0] : edge; },
    create: (who, input, references) => {
      noReferences(references);
      return saveEdge(db, who, input);
    },
    update: (who, current, input, revision, references) => {
      noReferences(references);
      return saveEdge(db, who, input, current, revision);
    },
  });
  return [
    types,
    nodes,
    edges,
    organizationGoalsEntity(db),
  ];
}

import { z } from "zod";
import { readType } from "../lib/type-metadata";
import {
  defineEntity,
  entityRef,
  type EntityProvider,
} from "@ai-outfitter/app-sdk/entities";
import {
  and,
  eq,
  inArray,
  or,
  sql,
  type AnyColumn,
  type SQLWrapper,
} from "drizzle-orm";
import { appRecordKey } from "@ai-outfitter/app-sdk/graph-contracts";
import { pageCondition } from "@ai-outfitter/app-sdk/entity-query";
import { containsInsensitive, within } from "@ai-outfitter/app-sdk/graph-filter-sql";
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
import { recordAddress } from "../lib/addresses";

const textFilter = z.string().min(1).max(200);
const identifiers = z.array(textFilter).min(1).max(100);
const commonFilter = {
  titleContains: textFilter.optional(),
  archived: z.boolean().optional(),
};
const typeFilter = z.strictObject({
  ...commonFilter,
  name: textFilter.optional(),
  names: identifiers.optional(),
  category: z.enum(["node", "edge"]).optional(),
});
const nodeFilter = z.strictObject({
  ...commonFilter,
  typeId: textFilter.optional(),
  typeIds: identifiers.optional(),
  slug: textFilter.optional(),
  source: entityRef.optional(),
  properties: z.record(z.string().regex(/^[A-Za-z0-9_]{1,64}$/), z.union([z.string().max(200), z.number(), z.boolean()])).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 8, "Match 1 to 8 properties").optional()
    .describe("Stored property values that must match exactly."),
});
const edgeFilter = z.strictObject({
  ...commonFilter,
  typeId: textFilter.optional(),
  typeIds: identifiers.optional(),
  fromId: textFilter.optional(),
  fromTypeIds: identifiers.optional(),
  toId: textFilter.optional(),
  nodeId: textFilter.optional(),
  nodeIds: identifiers.optional(),
});
/** Literal, case-insensitive title substring: '%' and '_' have no wildcard meaning. */
const titleCondition = (column: SQLWrapper, value?: string) =>
  value === undefined ? undefined : containsInsensitive(column, value);

/** Lists bind as one JSON parameter, whatever their length. */
const among = (column: AnyColumn, values?: string[]) => values === undefined ? undefined : sql`${column} IN ${within(values)}`;

const equals = (column: AnyColumn, value: string | boolean | undefined) =>
  value === undefined ? undefined : eq(column, value);

const nodesCondition = (ids?: string[]) => ids === undefined ? undefined : or(among(graphEdges.fromId, ids), among(graphEdges.toId, ids));

type Named = { address?: string };
/** Edges with their address, such as works_on(Person:ada → Project:sunny), for naming. */
async function named(db: Database, edges: GraphEdge[]) {
  if (!edges.length) return edges;
  const nodeIds = [...new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]))];
  const nodes = await db.select({ id: graphNodes.id, typeId: graphNodes.typeId, slug: graphNodes.slug }).from(graphNodes).where(among(graphNodes.id, nodeIds));
  const typeIds = [...new Set([...edges.map((edge) => edge.typeId), ...nodes.map((node) => node.typeId)])];
  const types = await db.select({ id: graphTypes.id, name: graphTypes.name }).from(graphTypes).where(among(graphTypes.id, typeIds));
  const address = recordAddress({ types, nodes, edges } as unknown as Parameters<typeof recordAddress>[0]);
  return edges.map((edge): GraphEdge & Named => ({ ...edge, address: address("graph-edge", edge.id) ?? undefined }));
}

/** Nodes with their address, such as Person:ada, so a reader can write about them without ids. */
async function addressed(db: Database, nodes: GraphNode[]) {
  if (!nodes.length) return nodes;
  const types = await db.select({ id: graphTypes.id, name: graphTypes.name }).from(graphTypes).where(among(graphTypes.id, [...new Set(nodes.map((node) => node.typeId))]));
  const names = new Map(types.map((type) => [type.id, type.name]));
  return nodes.map((node): GraphNode & Named => ({ ...node, address: names.has(node.typeId) ? `${names.get(node.typeId)}:${node.slug}` : undefined }));
}
const withAddress = (row: Parameters<typeof provenance>[0] & Named) => ({ ...provenance(row), ...(row.address ? { address: row.address } : {}) });

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
    // Each advertised order has an index behind it: the primary key and the unique name.
    orderFields: ["id", "name"],
    selectFields: ["id", ...Object.keys(typeInput.shape)],
    searchFields: ["name", "title", "body"],
    title: "Wiki type definition",
    description:
      "Documented node or directed relationship type. Definitions declare scalar properties, optional body jsonSchema and a versioned ontology contract. Relators declare participation; projections are read-only. Read that schema before authoring a structured node body. Existing records must remain valid when definitions change. Provenance and seedVersion are read-only. Archive unused definitions with archived:true. No semantic relationship grants authorization.",
    schema: typeInput,
    outputAttributes: provenance,
    filterSchema: typeFilter,
    // A type is named by the name addresses use (Person, supplied_by), not its display title (People).
    name: (row) => row.name || row.title,
    list: async (_who, query) => {
      const f = query.filter ?? {};
      const page = pageCondition(query, { id: graphTypes.id, order: { name: graphTypes.name }, search: [graphTypes.name, graphTypes.title, graphTypes.body] });
      return (
        await db
          .select()
          .from(graphTypes)
          .where(
            and(
              page.where,
              titleCondition(graphTypes.title, f.titleContains),
              equals(graphTypes.archived, f.archived),
              equals(graphTypes.name, f.name),
              among(graphTypes.name, f.names),
              equals(graphTypes.category, f.category),
            ),
          )
          .orderBy(...page.orderBy)
          .limit(query.limit)
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
    // Each order has an index with the type and one without (migration 0004): (typeId, field, id) and (field, id).
    orderFields: ["id", "title", "createdAt", "updatedAt"],
    selectFields: ["id", ...Object.keys(nodeInput.shape)],
    searchFields: ["title", "slug", "summary", "body"],
    title: "Wiki graph node",
    description:
      "Typed node documenting an identifiable thing or relator. Create a complete relator with its participation links in graph.apply. Assertion nodes use the SDK assertionBody schema; authenticated confirmation is a separate receipt. Discover graph-type for permitted properties and the optional body jsonSchema. Structured bodies are JSON serialized into the body string. Projects may document external work without an app reference; optionally link a canonical Planning project. Read-only provenance records writers; no private contact fields or external identifiers are exposed. When updating a sourced node, include its current canonical reference. archived:true reversibly removes a node from active views.",
    schema: nodeInput,
    outputAttributes: withAddress,
    filterSchema: nodeFilter,
    name: (row) => row.title,
    references: (row) => (row.source ? [row.source] : []),
    list: async (_who, query) => {
      const f = query.filter ?? {};
      const page = pageCondition(query, { id: graphNodes.id, order: { title: graphNodes.title, createdAt: graphNodes.createdAt, updatedAt: graphNodes.updatedAt }, search: [graphNodes.title, graphNodes.slug, graphNodes.summary, graphNodes.body] });
      return addressed(db, (
        await db
          .select()
          .from(graphNodes)
          .where(
            and(
              page.where,
              titleCondition(graphNodes.title, f.titleContains),
              equals(graphNodes.archived, f.archived),
              equals(graphNodes.typeId, f.typeId),
              among(graphNodes.typeId, f.typeIds),
              equals(graphNodes.slug, f.slug),
              f.source === undefined ? undefined : eq(graphNodes.externalKey, appRecordKey(f.source)),
              ...Object.entries(f.properties ?? {}).map(([name, value]) => sql`json_extract(${graphNodes.properties}, ${`$.${name}`}) = ${value}`),
            ),
          )
          .orderBy(...page.orderBy)
          .limit(query.limit)
      ).map(nodeView));
    },
    get: async (_who, id) => { const node = await getNode(db, id); return node ? (await addressed(db, [node]))[0] : node; },
    create: (who, input, references) =>
      saveNode(db, who, context, input, references),
    update: (who, current, input, revision, references) =>
      saveNode(db, who, context, input, references, current, revision),
  });
  const edges = defineEntity<GraphEdge, typeof edgeInput, typeof edgeFilter>({
    type: "graph-edge",
    collection: "edges",
    orderFields: ["id"],
    selectFields: ["id", ...Object.keys(edgeInput.shape)],
    searchFields: ["title", "body"],
    title: "Wiki directed relationship",
    description:
      "Stored relationship with its own identity, revision, properties, narrative and read-only provenance. Use graph.relationships for direction-independent symmetric lookup and read-only derived views. Discover graph-type for meaning and property definitions. archived:true reversibly deletes a relationship.",
    schema: edgeInput,
    outputAttributes: withAddress,
    filterSchema: edgeFilter,
    // An untitled edge is named by its address, never its UUID.
    name: (row) => row.title || (row as Named).address || row.id,
    list: async (_who, query) => {
      const f = query.filter ?? {};
      const page = pageCondition(query, { id: graphEdges.id, search: [graphEdges.title, graphEdges.body] });
      return named(db, (
        await db
          .select()
          .from(graphEdges)
          .where(
            and(
              page.where,
              titleCondition(graphEdges.title, f.titleContains),
              equals(graphEdges.archived, f.archived),
              equals(graphEdges.typeId, f.typeId),
              among(graphEdges.typeId, f.typeIds),
              equals(graphEdges.fromId, f.fromId),
              f.fromTypeIds === undefined ? undefined : inArray(graphEdges.fromId,
                db.select({ id: graphNodes.id }).from(graphNodes).where(among(graphNodes.typeId, f.fromTypeIds))),
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
          .orderBy(...page.orderBy)
          .limit(query.limit)
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

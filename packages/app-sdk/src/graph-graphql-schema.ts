// Builds the GraphQL schema of one graph from its type rows. Naming rules are in
// graph-graphql.ts; layout decisions in graph-graphql-names.ts.
import {
  GraphQLBoolean, type GraphQLEnumType, GraphQLError, type GraphQLFieldConfig, type GraphQLFieldConfigArgumentMap, type GraphQLFieldConfigMap, GraphQLFloat, GraphQLID, type GraphQLInputObjectType, GraphQLInt,
  GraphQLInterfaceType, GraphQLList, type GraphQLNamedType, GraphQLNonNull, GraphQLObjectType, type GraphQLOutputType, GraphQLSchema, GraphQLString, printSchema,
  type GraphQLResolveInfo,
} from "graphql";
import { type EdgeLayout, type NodeLayout, type SchemaLayout, schemaLayout, type TypeRow } from "./graph-graphql-names";
import {
  checkedFilter, type GraphContext, idList, meterFields, type OrderedPageArgs, orderedPage, orderedStart, type PageArgs, take, traverse, type TraverseArgs, validFrom, validUntil, visible,
} from "./graph-graphql-resolve";
import { ArchivedEnum, DateTimeScalar, DirectionEnum, filterInput, JSONScalar, operatorInput, orderEnum } from "./graph-graphql-scalars";
import { edgeFilterFields, nodeFilterFields } from "./graph-filter";
import { type ArchivedFilter, type GraphRow, keyOf, type NodeFilter, type RelationCountAsk } from "./graph-graphql-source";

type Fields = GraphQLFieldConfigMap<GraphRow, GraphContext>;
type RootFields = GraphQLFieldConfigMap<unknown, GraphContext>;
export type GraphSchemaOptions = {
  /** Extra root fields; a function receives the generated types by GraphQL name. A map's
   * keys are kept from generated root names; for a function, name its fields in rootFieldNames. */
  rootExtensions?: RootFields | ((generated: Map<string, GraphQLNamedType>) => RootFields);
  /** Root field names the function form of rootExtensions returns. */
  rootFieldNames?: string[];
  /** Type names rootExtensions defines (e.g. "Viewer"), kept from generated type names. */
  typeNames?: string[];
  /** Extra fields on Node, Edge and every generated node and edge type, resolved from the row;
   * their names are kept from stored property names. */
  recordFields?: Fields;
  /** For a source whose record keys are not the IDs shown (a schema composed over several graphs keys
   * records by graph and ID): `id`, `fromId` and `toId` show `shownId(key)`, and by-key roots take `args`
   * and find their record with `find` (given one of `id` and `slug`, and the type and visibility test the root applies). */
  recordKeys?: {
    shownId: (key: string) => string;
    args?: GraphQLFieldConfigArgumentMap;
    find: (args: KeyArgs & Record<string, unknown>, context: GraphContext, keep: (row: GraphRow) => boolean) => Promise<GraphRow | null>;
  };
};
/** What a by-key root was asked for: exactly one of `id` and `slug` (checked before `find` runs). */
export type KeyArgs = { id?: string | null; slug?: string | null };

const nonNull = <T extends GraphQLOutputType>(type: T) => new GraphQLNonNull(type);
const list = (type: GraphQLOutputType) => nonNull(new GraphQLList(nonNull(type)));
const scalarOf: Record<string, GraphQLOutputType> = { string: GraphQLString, number: GraphQLFloat, boolean: GraphQLBoolean };
const typed: Record<string, (value: unknown) => boolean> = {
  string: value => typeof value === "string", number: value => typeof value === "number" && Number.isFinite(value), boolean: value => typeof value === "boolean",
};
/** Relay's PageInfo. Paging is forward only (first and after), so hasPreviousPage says whether the page started after a cursor. */
export const PageInfo = new GraphQLObjectType({ name: "PageInfo", fields: {
  hasNextPage: { type: nonNull(GraphQLBoolean) }, hasPreviousPage: { type: nonNull(GraphQLBoolean) }, startCursor: { type: GraphQLString }, endCursor: { type: GraphQLString },
} });
/** A Relay connection of `item` with PostGraphile's `nodes` and `totalCount`: `edges { cursor node }`, `nodes`, `pageInfo`
 * and `totalCount` (counted only when selected). `edge` names the `{ cursor node }` wrapper. */
export function connectionOf(name: string, edge: string, item: GraphQLOutputType) {
  // No descriptions: every connection repeats this shape, and a Wiki's schema has one per type.
  const wrapper = new GraphQLObjectType({ name: edge, fields: () => ({ cursor: { type: nonNull(GraphQLString) }, node: { type: nonNull(item) } }) });
  return new GraphQLObjectType({ name, fields: () => ({
    edges: { type: list(wrapper) }, nodes: { type: list(item) }, pageInfo: { type: nonNull(PageInfo) }, totalCount: { type: nonNull(GraphQLInt) },
  }) });
}
const traverseArgs: GraphQLFieldConfigArgumentMap = {
  at: { type: DateTimeScalar },
  archived: { type: ArchivedEnum, defaultValue: "exclude" },
};
const pageArgs: GraphQLFieldConfigArgumentMap = { first: { type: GraphQLInt, defaultValue: 100 }, after: { type: GraphQLString } };
/** first (default 100, at most 500), after, orderBy (default ID_ASC) and filter. */
const orderedArgs = (order: GraphQLEnumType, filter: GraphQLInputObjectType): GraphQLFieldConfigArgumentMap =>
  ({ ...pageArgs, orderBy: { type: order, defaultValue: "ID_ASC" }, filter: { type: filter } });
type RelationArgs = TraverseArgs & OrderedPageArgs & { filter?: unknown };
const strings = new GraphQLList(nonNull(GraphQLString));

function propertyFields(properties: (NodeLayout | EdgeLayout)["properties"]): Fields {
  return Object.fromEntries(properties.map(({ field, property }) => [field, {
    type: scalarOf[property.type ?? ""] ?? JSONScalar,
    resolve: (row: GraphRow) => {
      const value = (row.properties as Record<string, unknown> | null | undefined)?.[property.name];
      return value === undefined || (typed[property.type ?? ""] && !typed[property.type ?? ""](value)) ? null : value;
    },
  }]));
}
const recordBase = (shown: (key: string) => string): Fields => ({
  id: { type: nonNull(GraphQLID), resolve: row => shown(row.id) }, typeId: { type: nonNull(GraphQLID) }, revision: { type: nonNull(GraphQLInt) },
  title: { type: nonNull(GraphQLString), resolve: row => String(row.title ?? "") }, body: { type: GraphQLString },
  archived: { type: nonNull(GraphQLBoolean), resolve: row => !!row.archived }, updatedAt: { type: DateTimeScalar },
  properties: { type: JSONScalar, resolve: row => row.properties ?? {} },
});
const validityFields = (): Fields => ({ validFrom: { type: DateTimeScalar, resolve: validFrom }, validUntil: { type: DateTimeScalar, resolve: validUntil } });

/** Resolves type references in arguments: Wiki names, IDs or GraphQL names. */
function typeRefs(layout: SchemaLayout, category: "node" | "edge") {
  const index = new Map<string, string>();
  for (const { type, name } of category === "node" ? layout.nodes.values() : layout.edges.values()) for (const key of [type.id, type.name, name]) index.set(key, type.id);
  return (refs: string[] | null | undefined) => (refs ? [...new Set(refs.flatMap(ref => index.get(ref) ?? []))] : null);
}

/** A node address: its type name and slug, such as `Organization:sunny`. */
const nodeAddress = /^([A-Za-z_][A-Za-z0-9_]*):(.+)$/;
/** A by-key root's record: through recordKeys when the source keys records, else by ID, address or slug
 * (slugs are unique per type, so a bare slug is the first match the root accepts). */
async function findByKey(keys: GraphSchemaOptions["recordKeys"], args: KeyArgs, context: GraphContext, keep: (row: GraphRow) => boolean,
  typeIdOf: (name: string) => string | undefined) {
  if (!args.id === !args.slug) throw new GraphQLError("Pass exactly one of id and slug", { extensions: { code: "BAD_USER_INPUT" } });
  if (keys) return keys.find(args, context, keep);
  const address = args.id ? nodeAddress.exec(args.id) : null;
  if (address) {
    const typeId = typeIdOf(address[1]);
    return (await context.loader.slug(address[2])).find(row => row.typeId === typeId && keep(row)) ?? null;
  }
  if (args.id) {
    const row = await context.loader.node(args.id);
    return row && keep(row) ? row : null;
  }
  return (await context.loader.slug(args.slug as string)).find(keep) ?? null;
}
/** How record keys show and which extra arguments by-key roots take. */
const keyed = (keys: GraphSchemaOptions["recordKeys"]) => ({ shown: keys?.shownId ?? ((key: string) => key), idArgs: keys?.args ?? {} });

/** Build the schema for one graph's type rows; archived types are left out. */
export function buildGraphSchema(types: TypeRow[], options: GraphSchemaOptions = {}): GraphQLSchema {
  const extensions = typeof options.rootExtensions === "function" ? null : options.rootExtensions ?? {};
  const record = options.recordFields ?? {};
  const keys = options.recordKeys;
  const { shown, idArgs } = keyed(keys);
  const layout = schemaLayout(types, { rootFieldNames: [...Object.keys(extensions ?? {}), ...options.rootFieldNames ?? []], typeNames: options.typeNames,
    recordFieldNames: Object.keys(record) });
  const generated = new Map<string, GraphQLNamedType>();
  const nodeName = (row: GraphRow) => layout.nodes.get(row.typeId)?.name;
  const edgeName = (row: GraphRow) => layout.edges.get(row.typeId)?.name;
  const knownNode = (row: GraphRow | undefined): row is GraphRow => !!row && !!nodeName(row);
  const edgeTypes = typeRefs(layout, "edge"), nodeTypes = typeRefs(layout, "node");
  const endpoint = (key: "fromId" | "toId"): GraphQLFieldConfig<GraphRow, GraphContext> => ({ type: Node, resolve: async (row, _args, context) => {
    const node = await context.loader.node(String(row[key]));
    return knownNode(node) ? node : null;
  } });
  const fromTo = (): Fields => ({ fromId: { type: nonNull(GraphQLID), resolve: row => shown(String(row.fromId)) }, toId: { type: nonNull(GraphQLID), resolve: row => shown(String(row.toId)) }, from: endpoint("fromId"), to: endpoint("toId") });
  /** By ID or slug (one of them), archived records only when asked for, as graph.query matches. */
  const byKey = (accept: (row: GraphRow) => boolean): GraphQLFieldConfig<unknown, GraphContext> => ({
    args: { id: { type: GraphQLID, description: "The node's address, such as Organization:sunny." }, slug: { type: GraphQLString, description: "The node's slug, unique within its type; pass id or slug." }, archived: traverseArgs.archived, ...idArgs }, type: Node,
    resolve: async (_root, args: KeyArgs & { archived: ArchivedFilter }, context) => {
      const keep = (row: GraphRow) => accept(row) && visible(row, args.archived, false);
      return findByKey(keys, args, context, keep, name => nodeTypes([name])?.[0]);
    },
  });
  const edgesField = (): GraphQLFieldConfig<GraphRow, GraphContext> => ({
    type: nonNull(edgeConnection()), description: "Edges of any type touching this node, each with from and to: one bounded, ordered page, read for every node of a level at once.",
    args: { types: { type: strings, description: "Edge type names or IDs." }, direction: { type: DirectionEnum, defaultValue: "both" }, ...orderedArgs(edgeOrder(), edgeFilter()), ...traverseArgs },
    resolve: async (row, args: RelationArgs & { types?: string[]; direction: "outgoing" | "incoming" | "both" }, context, info) => {
      const ids = edgeTypes(args.types) ?? allEdgeTypes;
      if (!ids.length) return collectionPage(null, args, context, info);
      return relationConnection(context, info, row.id, { edgeTypeIds: ids, direction: args.direction, targetTypeIds: allNodeTypes, rows: "edge", ...reach(args),
        ...checkedFilter(args.filter, edgeFilterFields) }, args);
    },
  });
  const Node: GraphQLInterfaceType = new GraphQLInterfaceType({
    name: "Node", description: "Any graph node.", resolveType: row => nodeName(row as GraphRow),
    fields: () => ({ ...recordBase(shown), summary: { type: GraphQLString }, slug: { type: GraphQLString }, edges: edgesField(), ...record }),
  });
  const Edge: GraphQLInterfaceType = new GraphQLInterfaceType({
    name: "Edge", description: "Any stored relationship.", resolveType: row => edgeName(row as GraphRow),
    fields: () => ({ ...recordBase(shown), ...fromTo(), ...validityFields(), ...record }),
  });
  const objects = new Map<string, GraphQLObjectType>();
  const connections = new Map<string, GraphQLObjectType>();
  const orderEnums = new Map([...layout.nodes.values()].map(node => [node.type.id, orderEnum(node.order, `${node.name} records`)]));
  /** Shared types are made only when a field uses them. */
  const lazy = <T>(make: () => T) => { let made: T | undefined; return () => (made ??= make()); };
  const { shared } = layout;
  const operators = { id: lazy(() => operatorInput(shared.idFilter, "id")), string: lazy(() => operatorInput(shared.stringFilter, "string")), datetime: lazy(() => operatorInput(shared.dateTimeFilter, "datetime")) };
  /** A filter over a record's indexed fields (nodeFilterFields, or edgeFilterFields without slug). */
  const recordFilter = (name: string, fields: Record<string, "id" | "string" | "datetime">) =>
    filterInput(name, Object.fromEntries(Object.entries(fields).map(([field, kind]) => [field, operators[kind]()])));
  const filters = new Map([...layout.nodes.values()].map(node => [node.type.id, recordFilter(node.filter, nodeFilterFields)]));
  const nodeFilter = lazy(() => recordFilter(shared.nodeFilter, nodeFilterFields));
  const edgeFilter = lazy(() => recordFilter(shared.edgeFilter, edgeFilterFields));
  const nodeConnection = lazy(() => connectionOf(shared.nodeConnection, shared.nodeConnectionEdge, Node));
  const edgeConnection = lazy(() => connectionOf(shared.edgeConnection, shared.edgeConnectionEdge, Edge));
  const nodeOrder = lazy(() => orderEnum(shared.nodeOrder, "nodes"));
  const edgeOrder = lazy(() => orderEnum(shared.edgeOrder, "edges"));
  const edgeConnections = new Map([...layout.edges.values()].map(edge => [edge.type.id, lazy(() => connectionOf(edge.connection, edge.connectionEdge, objects.get(edge.type.id) as GraphQLObjectType))]));
  const target = (ids: string[]) => (ids.length === 1 && objects.get(ids[0])) || Node;
  /** The connection, orderBy and filter of a field reaching these node types (the Node interface's for several). */
  const reaching = (ids: string[]) => (ids.length === 1 && connections.has(ids[0])
    ? { connection: connections.get(ids[0]) as GraphQLObjectType, order: orderEnums.get(ids[0]) as GraphQLEnumType, filter: filters.get(ids[0]) as GraphQLInputObjectType }
    : { connection: nodeConnection(), order: nodeOrder(), filter: nodeFilter() });
  const allNodeTypes = [...layout.nodes.keys()], allEdgeTypes = [...layout.edges.keys()];
  /** One parent's page of a relationship, batched with every other parent asking the same; counted only when totalCount is selected. */
  async function relationConnection(context: GraphContext, info: GraphQLResolveInfo, parentId: string, ask: RelationCountAsk, args: RelationArgs) {
    const start = orderedStart(args);
    const rows = await context.loader.relation({ ...ask, order: start.order, first: start.first, after: start.after }, parentId);
    const records = rows.map(row => (ask.rows === "node" ? row.node : row.edge));
    return orderedPage(context, info, records, row => keyOf(row, start.order), start, args.after, () => context.loader.relationCount(ask, parentId));
  }
  /** What traversal keeps of a relationship: visible under `archived`, valid at `at`. */
  const reach = (args: TraverseArgs) => ({ archived: args.archived ?? "exclude", ...(args.at ? { at: args.at } : {}) });

  for (const edge of layout.edges.values()) objects.set(edge.type.id, new GraphQLObjectType<GraphRow, GraphContext>({
    name: edge.name, interfaces: [Edge], description: String(edge.type.title ?? edge.type.name),
    fields: () => ({ ...recordBase(shown), ...fromTo(), ...validityFields(), ...propertyFields(edge.properties), ...record }),
  }));
  for (const node of layout.nodes.values()) {
    objects.set(node.type.id, new GraphQLObjectType<GraphRow, GraphContext>({
      name: node.name, interfaces: [Node], description: String(node.type.title ?? node.type.name),
      fields: () => ({
        ...recordBase(shown), summary: { type: GraphQLString }, slug: { type: GraphQLString }, edges: edgesField(),
        ...validityFields(), ...propertyFields(node.properties),
        ...slotFields(node), ...relationshipFields(node), ...reverseFields(node), ...record,
      }),
    }));
    connections.set(node.type.id, connectionOf(node.connection, node.connectionEdge, objects.get(node.type.id) as GraphQLObjectType));
  }

  /** Relationships are connections: one bounded, ordered page per parent, read for every parent at once. */
  function relationshipFields(node: NodeLayout): Fields {
    return Object.fromEntries(node.relationships.map(relation => {
      const { connection, order, filter } = relation.edges
        ? { connection: (edgeConnections.get(relation.edgeType.id) as () => GraphQLObjectType)(), order: edgeOrder(), filter: edgeFilter() }
        : reaching(relation.targets);
      // A projection reaches the other slot's participants through the relator: two hops, read as one page (RelationFilter.through).
      const { projection } = relation;
      const ask: Omit<RelationCountAsk, "archived" | "at" | "filter"> = projection
        ? { edgeTypeIds: [projection.to.edgeTypeId], direction: "both", targetTypeIds: relation.targets, rows: "node",
          through: { edgeTypeIds: [projection.via.edgeTypeId], nodeTypeIds: [projection.relatorTypeId] } }
        : { edgeTypeIds: [relation.edgeType.id], direction: relation.direction, targetTypeIds: relation.targets.length ? relation.targets : allNodeTypes, rows: relation.edges ? "edge" : "node" };
      return [relation.field, {
        type: nonNull(connection),
        args: { ...orderedArgs(order, filter), ...traverseArgs },
        resolve: async (row: GraphRow, args: RelationArgs, context: GraphContext, info) =>
          relationConnection(context, info, row.id, { ...ask, ...reach(args), ...checkedFilter(args.filter, relation.edges ? edgeFilterFields : nodeFilterFields) }, args),
      } satisfies GraphQLFieldConfig<GraphRow, GraphContext>];
    }));
  }
  function slotFields(node: NodeLayout): Fields {
    return Object.fromEntries(node.slots.map(({ field, slot }) => {
      const single = slot.max === 1;
      const type = target(slot.participantTypes.filter(id => layout.nodes.has(id)));
      return [field, {
        type: single ? type : list(type), args: { archived: traverseArgs.archived },
        resolve: async (row: GraphRow, args: TraverseArgs, context: GraphContext, info) => {
          const found = (await traverse(context, row.id, [slot.edgeTypeId], "both", args))
            .map(({ other }) => other).filter(other => knownNode(other) && slot.participantTypes.includes(other.typeId));
          return single ? found[0] ?? null : take(context, info, found);
        },
      } satisfies GraphQLFieldConfig<GraphRow, GraphContext>];
    }));
  }
  function reverseFields(node: NodeLayout): Fields {
    return Object.fromEntries(node.reverse.map(({ field, relator, slots }) => [field, {
      type: nonNull(connections.get(relator.id) as GraphQLObjectType),
      description: `as: ${slots.map(slot => slot.name).join(", ")}`,
      args: { as: { type: GraphQLString }, ...orderedArgs(orderEnums.get(relator.id) as GraphQLEnumType, filters.get(relator.id) as GraphQLInputObjectType), ...traverseArgs },
      resolve: async (row: GraphRow, args: RelationArgs & { as?: string }, context: GraphContext, info) => {
        const edgeTypeIds = [...new Set(slots.filter(slot => !args.as || slot.name === args.as).map(slot => slot.edgeTypeId))];
        if (!edgeTypeIds.length) return collectionPage(null, args, context, info);
        return relationConnection(context, info, row.id, { edgeTypeIds, direction: "both", targetTypeIds: [relator.id], rows: "node", ...reach(args), ...checkedFilter(args.filter, nodeFilterFields) }, args);
      },
    } satisfies GraphQLFieldConfig<GraphRow, GraphContext>]));
  }

  type CollectionArgs = OrderedPageArgs & { archived: ArchivedFilter; ids?: string[]; filter?: unknown; text?: string; at?: string };
  const search = connectionOf("SearchConnection", shared.searchEdge, Node);
  /** What a search matches, or null when it names no type of this schema. */
  const searchFilter = (args: { text: string; types?: string[] }): NodeFilter | null => {
    const text = args.text.trim();
    if (!text || text.length > 256) throw new GraphQLError("text must be 1-256 characters", { extensions: { code: "BAD_USER_INPUT" } });
    const typeIds = nodeTypes(args.types) ?? allNodeTypes;
    return typeIds.length ? { typeIds, text, archived: "exclude" } : null;
  };
  /** A collection's page, read bounded by the source; counted only when totalCount is selected. */
  const collectionPage = async (filter: NodeFilter | null, args: OrderedPageArgs, context: GraphContext, info: GraphQLResolveInfo) => {
    const start = orderedStart(args);
    const rows = filter ? await context.loader.nodePage({ ...filter, order: start.order, first: start.first, after: start.after }) : [];
    return orderedPage(context, info, rows, row => keyOf(row, start.order), start, args.after, async () => (filter ? context.loader.nodeCount(filter) : 0));
  };
  const roots: RootFields = {
    sdl: { type: nonNull(GraphQLString), description: "This schema in SDL: a compact alternative to full introspection.", resolve: (_root, _args, _context, info) => printSchema(info.schema) },
    node: byKey(knownNode),
    search: {
      type: nonNull(search),
      description: "Case-insensitive text match over IDs, titles, bodies and stored data. Unarchived nodes in ID order, with a total count and cursor pagination. Continue with pageInfo.endCursor as after until hasNextPage is false; keep text, types and Wiki scope unchanged.",
      args: { text: { type: nonNull(GraphQLString) }, types: { type: strings, description: "Node type names or IDs." }, ...pageArgs },
      resolve: async (_root, args: { text: string; types?: string[] } & PageArgs, context, info) => collectionPage(searchFilter(args), args, context, info),
    },
  };
  for (const node of layout.nodes.values()) {
    const object = objects.get(node.type.id) as GraphQLObjectType;
    roots[node.single] = { ...byKey(row => row.typeId === node.type.id), type: object };
    roots[node.collection] = {
      type: nonNull(connections.get(node.type.id) as GraphQLObjectType),
      args: { ...orderedArgs(orderEnums.get(node.type.id) as GraphQLEnumType, filters.get(node.type.id) as GraphQLInputObjectType), archived: traverseArgs.archived,
        ids: { type: new GraphQLList(nonNull(GraphQLID)), description: "Known record IDs, read in one batch." }, text: { type: GraphQLString }, at: traverseArgs.at },
      resolve: async (_root, args: CollectionArgs, context, info) => collectionPage({ typeIds: [node.type.id], archived: args.archived,
        ...(args.ids ? { ids: idList(args.ids) } : {}), ...checkedFilter(args.filter, nodeFilterFields),
        ...(args.text?.trim() ? { text: args.text.trim() } : {}), ...(args.at ? { at: args.at } : {}) }, args, context, info),
    };
  }
  for (const type of [Node, Edge, ...objects.values(), ...connections.values(), ...orderEnums.values(), ...filters.values()]) generated.set(type.name, type);
  const added = extensions ?? (options.rootExtensions as (generated: Map<string, GraphQLNamedType>) => RootFields)(generated);
  const taken = Object.keys(added).filter(name => Object.hasOwn(roots, name));
  if (taken.length) throw new Error(`rootExtensions ${taken.join(", ")} collide with generated root fields; list them in rootFieldNames`);
  const query = new GraphQLObjectType<unknown, GraphContext>({ name: "Query", fields: () => ({ ...roots, ...added }) });
  const schema = new GraphQLSchema({ query, types: [...generated.values()], extensions: { naming: layout.warnings } });
  meterFields(Object.values(schema.getTypeMap()));
  return schema;
}

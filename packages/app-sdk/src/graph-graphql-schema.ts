// Builds the GraphQL schema of one graph from its type rows. Naming rules are in
// graph-graphql.ts; layout decisions in graph-graphql-names.ts.
import {
  GraphQLBoolean, GraphQLError, type GraphQLFieldConfig, type GraphQLFieldConfigArgumentMap, type GraphQLFieldConfigMap, GraphQLFloat, GraphQLID, GraphQLInt,
  GraphQLInterfaceType, GraphQLList, type GraphQLNamedType, GraphQLNonNull, GraphQLObjectType, type GraphQLOutputType, GraphQLSchema, GraphQLString, printSchema,
} from "graphql";
import { type EdgeLayout, type NodeLayout, type SchemaLayout, schemaLayout, type TypeRow } from "./graph-graphql-names";
import { connection, type GraphContext, idList, meterFields, type PageArgs, pageStart, take, traverse, type TraverseArgs, validAt, validFrom, validUntil, visible } from "./graph-graphql-resolve";
import { ArchivedEnum, DateTimeScalar, DirectionEnum, JSONScalar } from "./graph-graphql-scalars";
import type { ArchivedFilter, GraphRow } from "./graph-graphql-source";

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
export const PageInfo = new GraphQLObjectType({ name: "PageInfo", fields: { endCursor: { type: GraphQLString }, hasNextPage: { type: nonNull(GraphQLBoolean) } } });
export const Aggregate = new GraphQLObjectType({ name: "Aggregate", fields: { count: { type: nonNull(GraphQLInt) } } });
const traverseArgs: GraphQLFieldConfigArgumentMap = {
  at: { type: DateTimeScalar },
  archived: { type: ArchivedEnum, defaultValue: "exclude" },
};
const pageArgs: GraphQLFieldConfigArgumentMap = { first: { type: GraphQLInt, defaultValue: 100 }, after: { type: GraphQLString } };
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
    type: list(Edge), description: "Edges of any type touching this node, each with from and to.",
    args: { types: { type: strings, description: "Edge type names or IDs." }, direction: { type: DirectionEnum, defaultValue: "both" }, ...traverseArgs },
    resolve: async (row, args: TraverseArgs & { types?: string[]; direction: "outgoing" | "incoming" | "both" }, context, info) => {
      const ids = edgeTypes(args.types);
      if (ids && !ids.length) return [];
      const found = await traverse(context, row.id, ids, args.direction, args);
      return take(context, info, found.map(({ edge }) => edge).filter(edge => !!edgeName(edge)));
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
  const target = (ids: string[]) => (ids.length === 1 && objects.get(ids[0])) || Node;

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
    connections.set(node.type.id, new GraphQLObjectType({ name: node.connection, fields: () => ({
      nodes: { type: list(objects.get(node.type.id) as GraphQLObjectType) }, pageInfo: { type: nonNull(PageInfo) }, aggregate: { type: nonNull(Aggregate) },
    }) }));
  }

  function relationshipFields(node: NodeLayout): Fields {
    return Object.fromEntries(node.relationships.map(relation => [relation.field, {
      type: list(relation.edges ? objects.get(relation.edgeType.id) as GraphQLObjectType : target(relation.targets)),
      args: traverseArgs,
      resolve: async (row: GraphRow, args: TraverseArgs, context: GraphContext, info) => {
        if (relation.projection) return take(context, info, await projected(context, row, relation.projection, args));
        const found = (await traverse(context, row.id, [relation.edgeType.id], relation.direction, args))
          .filter(({ other }) => knownNode(other) && (!relation.targets.length || relation.targets.includes(other.typeId)));
        return take(context, info, found.map(({ edge, other }) => (relation.edges ? edge : other)));
      },
    } satisfies GraphQLFieldConfig<GraphRow, GraphContext>]));
  }
  /** Participants of `to` in the relators this row joins through `via`; never the row itself. */
  async function projected(context: GraphContext, row: GraphRow, { relatorTypeId, via, to }: NonNullable<NodeLayout["relationships"][number]["projection"]>, args: TraverseArgs) {
    const relators = (await traverse(context, row.id, [via.edgeTypeId], "both", args)).map(({ other }) => other).filter(other => other.typeId === relatorTypeId);
    const reached = await Promise.all(relators.map(relator => traverse(context, relator.id, [to.edgeTypeId], "both", args)));
    const seen = new Set([row.id]);
    return reached.flat().map(({ other }) => other)
      .filter(other => knownNode(other) && to.participantTypes.includes(other.typeId) && !seen.has(other.id) && !!seen.add(other.id));
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
      args: { as: { type: GraphQLString }, ...pageArgs, ...traverseArgs },
      resolve: async (row: GraphRow, args: TraverseArgs & PageArgs & { as?: string }, context: GraphContext, info) => {
        const lists = await Promise.all(slots.filter(slot => !args.as || slot.name === args.as)
          .map(slot => traverse(context, row.id, [slot.edgeTypeId], "both", args)));
        return connection(context, info, lists.flat().map(({ other }) => other).filter(other => other.typeId === relator.id), args);
      },
    } satisfies GraphQLFieldConfig<GraphRow, GraphContext>]));
  }

  type CollectionArgs = PageArgs & { archived: ArchivedFilter; ids?: string[]; slugs?: string[]; text?: string; at?: string };
  const searchConnection = new GraphQLObjectType({ name: "SearchConnection", fields: {
    nodes: { type: list(Node) }, pageInfo: { type: nonNull(PageInfo) }, aggregate: { type: nonNull(Aggregate) },
  } });
  const searchRows = async (args: { text: string; types?: string[] }, context: GraphContext) => {
    const text = args.text.trim();
    if (!text || text.length > 256) throw new GraphQLError("text must be 1-256 characters", { extensions: { code: "BAD_USER_INPUT" } });
    const ids = nodeTypes(args.types) ?? [...layout.nodes.keys()];
    return ids.length ? (await context.loader.nodes({ typeIds: ids, text, archived: "exclude" })).filter(knownNode) : [];
  };
  const roots: RootFields = {
    sdl: { type: nonNull(GraphQLString), description: "This schema in SDL: a compact alternative to full introspection.", resolve: (_root, _args, _context, info) => printSchema(info.schema) },
    node: byKey(knownNode),
    search: {
      type: list(Node), description: "Case-insensitive text match over IDs, titles, bodies and stored data; unarchived nodes in ID order.",
      deprecationReason: "At most 100 matches with no continuation. Use searchConnection for complete, cursor-paginated results.",
      args: { text: { type: nonNull(GraphQLString) }, types: { type: strings, description: "Node type names or IDs." }, first: { type: GraphQLInt, defaultValue: 20 } },
      resolve: async (_root, args: { text: string; types?: string[]; first: number }, context, info) => {
        if (args.first < 0 || args.first > 100) throw new GraphQLError("first must be between 0 and 100", { extensions: { code: "BAD_USER_INPUT" } });
        return take(context, info, (await searchRows(args, context)).slice(0, args.first));
      },
    },
    searchConnection: {
      type: nonNull(searchConnection),
      description: "Case-insensitive text match over IDs, titles, bodies and stored data. Unarchived nodes in ID order, with a total count and cursor pagination. Continue with pageInfo.endCursor as after until hasNextPage is false; keep text, types and Wiki scope unchanged.",
      args: { text: { type: nonNull(GraphQLString) }, types: { type: strings, description: "Node type names or IDs." }, ...pageArgs },
      resolve: async (_root, args: { text: string; types?: string[] } & PageArgs, context, info) => {
        pageStart(args);
        return connection(context, info, await searchRows(args, context), args);
      },
    },
  };
  for (const node of layout.nodes.values()) {
    const object = objects.get(node.type.id) as GraphQLObjectType;
    roots[node.single] = { ...byKey(row => row.typeId === node.type.id), type: object };
    roots[node.collection] = {
      type: nonNull(connections.get(node.type.id) as GraphQLObjectType),
      args: { ...pageArgs, archived: traverseArgs.archived, ids: { type: new GraphQLList(nonNull(GraphQLID)) }, slugs: { type: strings, description: "Exact slugs." }, text: { type: GraphQLString }, at: traverseArgs.at },
      resolve: async (_root, args: CollectionArgs, context, info) => {
        const rows = await context.loader.nodes({ typeIds: [node.type.id], archived: args.archived, ...(args.ids ? { ids: idList(args.ids) } : {}),
          ...(args.slugs ? { slugs: idList(args.slugs, "slugs") } : {}), ...(args.text?.trim() ? { text: args.text.trim() } : {}) });
        return connection(context, info, rows.filter(row => visible(row, args.archived, false) && validAt(row, args.at)), args);
      },
    };
  }
  for (const type of [Node, Edge, ...objects.values(), ...connections.values()]) generated.set(type.name, type);
  const added = extensions ?? (options.rootExtensions as (generated: Map<string, GraphQLNamedType>) => RootFields)(generated);
  const taken = Object.keys(added).filter(name => Object.hasOwn(roots, name));
  if (taken.length) throw new Error(`rootExtensions ${taken.join(", ")} collide with generated root fields; list them in rootFieldNames`);
  const query = new GraphQLObjectType<unknown, GraphContext>({ name: "Query", fields: () => ({ ...roots, ...added }) });
  const schema = new GraphQLSchema({ query, types: [...generated.values()], extensions: { naming: layout.warnings } });
  meterFields(Object.values(schema.getTypeMap()));
  return schema;
}

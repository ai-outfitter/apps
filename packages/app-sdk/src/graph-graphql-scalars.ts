import { GraphQLEnumType, GraphQLError, GraphQLScalarType, Kind, valueFromASTUntyped } from "graphql";
import type { Order } from "./graph-graphql-source";

export const JSONScalar = new GraphQLScalarType({
  name: "JSON", description: "Any JSON value.",
  serialize: value => value, parseValue: value => value, parseLiteral: (ast, variables) => valueFromASTUntyped(ast, variables),
});

const instant = (value: unknown) => {
  if (value === "NOW") return new Date().toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  throw new GraphQLError("DateTime takes an ISO-8601 string or \"NOW\"");
};
export const DateTimeScalar = new GraphQLScalarType({
  name: "DateTime", description: "ISO-8601 date or date-time; as input also \"NOW\".",
  serialize: value => (typeof value === "number" ? new Date(value).toISOString() : value instanceof Date ? value.toISOString() : String(value)),
  parseValue: instant,
  parseLiteral: ast => instant(ast.kind === Kind.STRING || ast.kind === Kind.ENUM ? ast.value : undefined),
});

export const ArchivedEnum = new GraphQLEnumType({
  name: "Archived", description: "EXCLUDE (default) hides archived records; on relationships also retired ones, as graph.query traversal does.",
  values: { EXCLUDE: { value: "exclude" }, INCLUDE: { value: "include" }, ONLY: { value: "only" } },
});
export const DirectionEnum = new GraphQLEnumType({
  name: "Direction", values: { OUTGOING: { value: "outgoing" }, INCOMING: { value: "incoming" }, BOTH: { value: "both" } },
});

/** orderBy values: a record column, ascending or descending, then the ID in the same direction.
 * ID_ASC is the default, so cursors made before orderBy keep their meaning. */
export const orders = {
  ID_ASC: { field: "id", descending: false }, ID_DESC: { field: "id", descending: true },
  CREATED_AT_ASC: { field: "createdAt", descending: false }, CREATED_AT_DESC: { field: "createdAt", descending: true },
  UPDATED_AT_ASC: { field: "updatedAt", descending: false }, UPDATED_AT_DESC: { field: "updatedAt", descending: true },
  TITLE_ASC: { field: "title", descending: false }, TITLE_DESC: { field: "title", descending: true },
} as const satisfies Record<string, Order>;
export type OrderName = keyof typeof orders;
export const isOrderName = (value: unknown): value is OrderName => typeof value === "string" && Object.hasOwn(orders, value);
/** An orderBy enum for one connection's records. */
export const orderEnum = (name: string, records: string) => new GraphQLEnumType({
  name, description: `How ${records} are ordered: by a column (createdAt and updatedAt are when the record was written), ties by ID.`,
  values: Object.fromEntries(Object.keys(orders).map(value => [value, { value }])),
});

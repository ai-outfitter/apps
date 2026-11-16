import {
  GraphQLBoolean, GraphQLEnumType, GraphQLError, GraphQLFloat, GraphQLID, GraphQLInputObjectType, type GraphQLInputType, GraphQLList, GraphQLNonNull, GraphQLScalarType,
  GraphQLString, Kind, valueFromASTUntyped,
} from "graphql";
import { comparisonOperators, type FilterKind, textOperators } from "./graph-filter";
import { orders } from "./graph-order";

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

/** An orderBy enum for one connection's records. */
export const orderEnum = (name: string, records: string) => new GraphQLEnumType({
  name, description: `How ${records} are ordered: by a column (createdAt and updatedAt are when the record was written), ties by ID.`,
  values: Object.fromEntries(Object.keys(orders).map(value => [value, { value }])),
});

const filterScalars: Record<FilterKind, GraphQLScalarType> = { id: GraphQLID, string: GraphQLString, number: GraphQLFloat, boolean: GraphQLBoolean, datetime: DateTimeScalar };
/** The operators one kind of field takes in a filter, named as PostGraphile's connection-filter names them. */
export function operatorInput(name: string, kind: FilterKind) {
  const scalar = filterScalars[kind];
  const operators = kind === "boolean" ? ["isNull", "equalTo", "notEqualTo"] : kind === "string" ? [...comparisonOperators, ...textOperators] : [...comparisonOperators];
  const typeOf = (operator: string): GraphQLInputType => operator === "isNull" ? GraphQLBoolean
    : operator === "in" || operator === "notIn" ? new GraphQLList(new GraphQLNonNull(scalar)) : operator.startsWith("includes") || operator.startsWith("startsWith") ? GraphQLString : scalar;
  return new GraphQLInputObjectType({
    name, description: `Conditions on one ${kind === "datetime" ? "date-time" : kind} field of a filter; every one given must hold, and a filter holds at most 20. They run in the database.${kind === "string" ? " includes and startsWith match literally; Insensitive ignores ASCII case." : ""}`,
    fields: Object.fromEntries(operators.map(operator => [operator, { type: typeOf(operator) }])),
  });
}
/** The operator inputs of an app's own tables (tableType), one instance per schema-wide name. */
export const tableOperators: Record<FilterKind, GraphQLInputObjectType> = {
  id: operatorInput("IDFilter", "id"), string: operatorInput("StringFilter", "string"), number: operatorInput("FloatFilter", "number"),
  boolean: operatorInput("BooleanFilter", "boolean"), datetime: operatorInput("DateTimeFilter", "datetime"),
};
/** A `filter` input over `fields`, with and, or and not: every condition given must hold, at most 20 in all.
 * Undescribed in the schema, as a Wiki has one per type; the operator inputs say what a condition is. */
export function filterInput(name: string, fields: Record<string, GraphQLInputObjectType>): GraphQLInputObjectType {
  const filter: GraphQLInputObjectType = new GraphQLInputObjectType({
    name,
    fields: () => ({
      ...Object.fromEntries(Object.entries(fields).map(([field, type]) => [field, { type }])),
      and: { type: new GraphQLList(new GraphQLNonNull(filter)) }, or: { type: new GraphQLList(new GraphQLNonNull(filter)) }, not: { type: filter },
    }),
  });
  return filter;
}

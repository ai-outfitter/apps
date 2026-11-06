import { GraphQLEnumType, GraphQLError, GraphQLScalarType, Kind, valueFromASTUntyped } from "graphql";

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

// The `filter` argument of connections, in PostGraphile connection-filter's shape:
// `{ field: { operator: value }, and: [...], or: [...], not: {...} }`. A filter names only
// the fields its owner declares (indexed columns), and is bounded so the statement it
// compiles to stays well inside D1's 100 bound parameters. This file is the shape, its
// checks and the in-memory meaning (for memorySource and tests); a database compiles the
// same filter to SQL (graph-filter-sql.ts), where it always runs in production.
import { z } from "zod";

/** Operators every field takes. */
export const comparisonOperators = ["isNull", "equalTo", "notEqualTo", "in", "notIn", "lessThan", "lessThanOrEqualTo", "greaterThan", "greaterThanOrEqualTo"] as const;
/** Operators only text fields take: literal substrings and prefixes (`Insensitive` folds ASCII case). */
export const textOperators = ["includes", "includesInsensitive", "startsWith", "startsWithInsensitive"] as const;
export const filterOperators = [...comparisonOperators, ...textOperators] as const;
export type FilterOperator = (typeof filterOperators)[number];
export type FilterScalar = string | number | boolean;
export type FieldOperators = { [Operator in FilterOperator]?: Operator extends "isNull" ? boolean : Operator extends "in" | "notIn" ? FilterScalar[] : FilterScalar };
export type RecordFilter = { and?: RecordFilter[]; or?: RecordFilter[]; not?: RecordFilter } & { [field: string]: FieldOperators | RecordFilter[] | RecordFilter | null | undefined };

/** How a field's values compare: `datetime` holds epoch milliseconds and takes ISO-8601 operands. */
export type FilterKind = "id" | "string" | "number" | "boolean" | "datetime";
export type FilterFields = Record<string, FilterKind>;
/** The node fields a filter may name: each is indexed with the node's type. */
export const nodeFilterFields = { id: "id", slug: "string", title: "string", createdAt: "datetime", updatedAt: "datetime" } as const satisfies FilterFields;
/** The edge fields a filter may name; an edge page is read from its parents' edges. */
export const edgeFilterFields = { id: "id", title: "string", createdAt: "datetime", updatedAt: "datetime" } as const satisfies FilterFields;

/** Most conditions (one operator on one field) in a filter: each binds one parameter. */
export const maxFilterConditions = 20;
/** Most values in one `in` or `notIn` list (bound as one JSON array). */
export const maxFilterValues = 200;
const maxFilterDepth = 6;
const logical = new Set(["and", "or", "not"]);
const textual = new Set<string>(textOperators);
const known = new Set<string>(filterOperators);

/** A JSON object: neither null nor a list. */
export const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** The operators a field carries (null and undefined are no condition). */
const conditions = (field: unknown) => (isObject(field) ? Object.entries(field).filter(([, value]) => value !== null && value !== undefined) : []);
const children = (filter: RecordFilter): RecordFilter[] => [...filter.and ?? [], ...filter.or ?? [], ...(filter.not ? [filter.not] : [])];
const fieldsOf = (filter: RecordFilter) => Object.entries(filter).filter(([key, value]) => !logical.has(key) && value !== null && value !== undefined);

/** How many conditions a filter holds. */
export function filterConditions(filter: RecordFilter | null | undefined): number {
  if (!filter) return 0;
  return fieldsOf(filter).reduce((sum, [, field]) => sum + conditions(field).length, 0) + children(filter).reduce((sum, child) => sum + filterConditions(child), 0);
}

/** A filter operand as its field compares it: a datetime as epoch milliseconds, a boolean as 0 or 1. */
export function filterOperand(kind: FilterKind, value: unknown): string | number {
  if (kind === "datetime") {
    const time = typeof value === "number" ? value : Date.parse(String(value));
    if (!Number.isFinite(time)) throw new Error("A date filter takes an ISO-8601 date or date-time");
    return time;
  }
  if (kind === "boolean") { if (typeof value !== "boolean") throw new Error("A boolean filter takes true or false"); return value ? 1 : 0; }
  if (kind === "number") { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("A number filter takes a number"); return value; }
  if (typeof value !== "string") throw new Error("A text filter takes a string");
  return value;
}

function checkText(name: string, kind: FilterKind, operator: string, value: unknown) {
  if (kind !== "string") throw new Error(`filter.${name}.${operator} is only for text fields`);
  if (typeof value !== "string" || value.length > 256) throw new Error(`filter.${name}.${operator} takes a string of at most 256 characters`);
}
function checkValues(name: string, kind: FilterKind, operator: string, values: unknown) {
  if (!Array.isArray(values) || values.length > maxFilterValues) throw new Error(`filter.${name}.${operator} takes a list of at most ${maxFilterValues} values`);
  for (const item of values) {
    filterOperand(kind, item);
    if (typeof item === "string" && item.length > 512) throw new Error(`filter.${name}.${operator} values are at most 512 characters`);
  }
}
function checkCondition(name: string, kind: FilterKind, operator: string, value: unknown) {
  if (!known.has(operator)) throw new Error(`filter.${name} has no operator ${operator}`);
  if (operator === "isNull") { if (typeof value !== "boolean") throw new Error(`filter.${name}.isNull takes true or false`); return; }
  if (textual.has(operator)) return checkText(name, kind, operator, value);
  if (kind === "boolean" && operator !== "equalTo" && operator !== "notEqualTo") throw new Error(`filter.${name} takes isNull, equalTo and notEqualTo`);
  checkValues(name, kind, operator, operator === "in" || operator === "notIn" ? value : [value]);
}
function checkLevel(filter: unknown, fields: FilterFields, depth: number) {
  if (!isObject(filter)) throw new Error("filter is an object of fields, and, or and not");
  if (depth > maxFilterDepth) throw new Error(`filter nests deeper than ${maxFilterDepth} levels`);
  for (const key of ["and", "or"] as const) if (filter[key] !== undefined && filter[key] !== null && !Array.isArray(filter[key])) throw new Error(`filter.${key} is a list of filters`);
  for (const [name, field] of fieldsOf(filter as RecordFilter)) {
    if (!Object.hasOwn(fields, name)) throw new Error(`filter has no field ${name}; it takes ${Object.keys(fields).join(", ")}, and, or and not`);
    if (!isObject(field)) throw new Error(`filter.${name} is an object of operators`);
    for (const [operator, value] of conditions(field)) checkCondition(name, fields[name], operator, value);
  }
  for (const child of children(filter as RecordFilter)) checkLevel(child, fields, depth + 1);
}
/** Refuse (with an Error that says why) a filter naming a field or operator its owner does not serve, or larger than a statement may bind. */
export function checkFilter(filter: unknown, fields: FilterFields): asserts filter is RecordFilter {
  checkLevel(filter, fields, 1);
  const count = filterConditions(filter as RecordFilter);
  if (count > maxFilterConditions) throw new Error(`filter has ${count} conditions; at most ${maxFilterConditions} fit one database statement (use in lists, or narrow the filter)`);
}

/** A filter as graph.query carries it; `checkFilter` then checks it against the fields of what it filters. */
export const recordFilterInput = z.record(z.string(), z.json());

type Tri = boolean | null;
/** SQL's three-valued AND, OR and NOT. */
const every = (values: Tri[]): Tri => (values.includes(false) ? false : values.includes(null) ? null : true);
const some = (values: Tri[]): Tri => (values.includes(true) ? true : values.includes(null) ? null : false);
const negate = (value: Tri): Tri => (value === null ? null : !value);
/** What SQLite's lower() folds: A to Z only, so a match in memory is the match SQL makes. */
export const foldCase = (text: string) => text.replace(/[A-Z]+/g, letters => letters.toLowerCase());
const compare = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** A stored value as its field compares it; null when the record holds none. */
function stored(kind: FilterKind, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (kind === "datetime") return typeof value === "number" ? value : Date.parse(String(value));
  if (kind === "boolean") return value ? 1 : 0;
  return typeof value === "number" ? value : String(value);
}
function test(kind: FilterKind, value: string | number | null, operator: string, operand: unknown): Tri {
  if (operator === "isNull") return (value === null) === operand;
  // An empty list holds nothing, whatever the value (as SQL's IN over no rows).
  if ((operator === "in" || operator === "notIn") && !(operand as unknown[]).length) return operator === "notIn";
  if (value === null) return null;
  if (textual.has(operator)) {
    const fold = operator.endsWith("Insensitive") ? foldCase : (text: string) => text;
    const [text, part] = [fold(String(value)), fold(String(operand))];
    return operator.startsWith("includes") ? text.includes(part) : text.startsWith(part);
  }
  if (operator === "in" || operator === "notIn") return (operand as unknown[]).some(item => filterOperand(kind, item) === value) === (operator === "in");
  const order = compare(value, filterOperand(kind, operand));
  switch (operator) {
    case "equalTo": return order === 0;
    case "notEqualTo": return order !== 0;
    case "lessThan": return order < 0;
    case "lessThanOrEqualTo": return order <= 0;
    case "greaterThan": return order > 0;
    default: return order >= 0;
  }
}
function evaluate(row: Record<string, unknown>, filter: RecordFilter, fields: FilterFields): Tri {
  const own = fieldsOf(filter).flatMap(([name, field]) => conditions(field).map(([operator, operand]) => test(fields[name], stored(fields[name], row[name]), operator, operand)));
  return every([
    ...own,
    ...(filter.and ? [every(filter.and.map(child => evaluate(row, child, fields)))] : []),
    ...(filter.or ? [some(filter.or.map(child => evaluate(row, child, fields)))] : []),
    ...(filter.not ? [negate(evaluate(row, filter.not, fields))] : []),
  ]);
}
/** Whether a record passes a (checked) filter, as the SQL it compiles to decides: a comparison with a missing value is unknown, and only true passes. */
export const matchesFilter = (row: Record<string, unknown>, filter: RecordFilter | null | undefined, fields: FilterFields) => !filter || evaluate(row, filter, fields) === true;

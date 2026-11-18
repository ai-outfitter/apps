// A connection filter (graph-filter.ts) as SQLite: one bound parameter per condition
// (`in` lists bind as one JSON array), so a checked filter adds at most
// maxFilterConditions parameters to its statement. Server only (drizzle-orm).
// Also the SQL every page shares, GraphQL connection or entity list: a list as one
// parameter (`within`), a case-insensitive substring (`containsInsensitive`) and the
// rows after a keyset cursor (`rowsAfter`).
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { type FieldOperators, type FilterKind, filterOperand, type RecordFilter } from "./graph-filter";

/** Where a filter field lives: its column (any SQL expression) and how its values compare. */
export type FilterColumns = Record<string, { column: SQL; kind: FilterKind }>;

/** Terms, each in parentheses, joined by `glue` (" AND ", " OR "). */
export const joined = (parts: SQL[], glue: string) => sql.join(parts.map(part => sql`(${part})`), sql.raw(glue));
/** Any number of values as one bound parameter (a JSON array), for `IN`: D1 binds at most 100 a statement. */
export const within = (values: unknown[]) => sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;
/** `column` holds `text` as a literal substring (`%` and `_` mean themselves), ignoring ASCII case: lower() folds
 * A to Z only, on both sides. Unknown for a missing value, as any comparison. */
export const containsInsensitive = (column: SQLWrapper, text: string) => sql`instr(lower(${column}), lower(${text})) > 0`;
/** The rows strictly after `key` in an order by `column` then `id`, both ascending or both `descending` (`column`
 * null: by the ID alone). A row-value comparison, so an index on (column, id) seeks it. No row value compares
 * with NULL, and SQLite sorts NULL first ascending and last descending: after a NULL key come the later NULL rows
 * and, ascending, every value; after a value, descending, come the NULL rows too (left out when the column is
 * not `nullable`, which keeps the comparison one index range). */
export function rowsAfter(column: SQLWrapper | null, id: SQLWrapper, descending: boolean, key: { value: unknown; id: string }, nullable = true): SQL {
  const beyond = sql.raw(descending ? "<" : ">");
  if (!column) return sql`${id} ${beyond} ${key.id}`;
  if (key.value === null) return descending ? sql`(${column} IS NULL AND ${id} < ${key.id})` : sql`(${column} IS NOT NULL OR ${id} > ${key.id})`;
  const later = sql`(${column}, ${id}) ${beyond} (${key.value}, ${key.id})`;
  return descending && nullable ? sql`(${later} OR ${column} IS NULL)` : later;
}
/** The least text greater than every text starting with `prefix` (code point order, as SQLite compares UTF-8),
 * or null when there is none: the prefix is empty or holds only the last code point. */
function prefixEnd(prefix: string) {
  const points = [...prefix].map(character => character.codePointAt(0) as number);
  while (points.at(-1) === 0x10ffff) points.pop();
  const last = points.pop();
  if (last === undefined) return null;
  // No text holds a surrogate code point: after U+D7FF comes U+E000.
  return String.fromCodePoint(...points, last === 0xd7ff ? 0xe000 : last + 1);
}
/** Text starting with `prefix` as a range, so an index on the column seeks it; unknown for a missing value, as any comparison. */
function startsWith(column: SQL, prefix: string) {
  const end = prefixEnd(prefix);
  return end === null ? sql`${column} >= ${prefix}` : sql`${column} >= ${prefix} AND ${column} < ${end}`;
}
const comparisons: Record<string, string> = { equalTo: "=", notEqualTo: "<>", lessThan: "<", lessThanOrEqualTo: "<=", greaterThan: ">", greaterThanOrEqualTo: ">=" };

function condition(column: SQL, kind: FilterKind, operator: string, operand: unknown): SQL {
  if (operator === "isNull") return operand ? sql`${column} IS NULL` : sql`${column} IS NOT NULL`;
  if (operator === "in" || operator === "notIn") {
    const list = within((operand as unknown[]).map(item => filterOperand(kind, item)));
    return operator === "in" ? sql`${column} IN ${list}` : sql`${column} NOT IN ${list}`;
  }
  // instr and the startsWith range match literally: `%` and `_` mean themselves. lower() folds ASCII only.
  if (operator === "includes") return sql`instr(${column}, ${String(operand)}) > 0`;
  if (operator === "includesInsensitive") return containsInsensitive(column, String(operand));
  if (operator === "startsWith") return startsWith(column, String(operand));
  if (operator === "startsWithInsensitive") return sql`instr(lower(${column}), lower(${String(operand)})) = 1`;
  return sql`${column} ${sql.raw(comparisons[operator])} ${filterOperand(kind, operand)}`;
}

/** One field's conditions; a null operand is no condition. */
const fieldConditions = ({ column, kind }: FilterColumns[string], field: FieldOperators) =>
  Object.entries(field).filter(([, operand]) => operand !== null && operand !== undefined).map(([operator, operand]) => condition(column, kind, operator, operand));
/** `and` of nothing holds; `or` of nothing does not. */
function logical(name: "and" | "or", filters: RecordFilter[], columns: FilterColumns): SQL {
  const parts = filters.map(child => compiled(child, columns));
  if (!parts.length) return name === "and" ? sql`1` : sql`0`;
  return joined(parts, name === "and" ? " AND " : " OR ");
}
function level(filter: RecordFilter, columns: FilterColumns): SQL[] {
  const parts: SQL[] = [];
  for (const [name, field] of Object.entries(filter)) {
    if (field === null || field === undefined) continue;
    if (name === "and" || name === "or") { parts.push(logical(name, field as RecordFilter[], columns)); continue; }
    if (name === "not") { parts.push(sql`NOT (${compiled(field as RecordFilter, columns)})`); continue; }
    parts.push(...fieldConditions(columns[name], field as FieldOperators));
  }
  return parts;
}
const compiled = (filter: RecordFilter, columns: FilterColumns): SQL => { const parts = level(filter, columns); return parts.length ? joined(parts, " AND ") : sql`1`; };

/** The WHERE term of a filter already checked against these fields (checkFilter), or undefined when it holds no condition. */
export function filterSql(filter: RecordFilter | null | undefined, columns: FilterColumns): SQL | undefined {
  if (!filter) return undefined;
  const parts = level(filter, columns);
  return parts.length ? joined(parts, " AND ") : undefined;
}

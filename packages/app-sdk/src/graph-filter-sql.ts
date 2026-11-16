// A connection filter (graph-filter.ts) as SQLite: one bound parameter per condition
// (`in` lists bind as one JSON array), so a checked filter adds at most
// maxFilterConditions parameters to its statement. Server only (drizzle-orm).
import { type SQL, sql } from "drizzle-orm";
import { type FieldOperators, type FilterKind, filterOperand, type RecordFilter } from "./graph-filter";

/** Where a filter field lives: its column (any SQL expression) and how its values compare. */
export type FilterColumns = Record<string, { column: SQL; kind: FilterKind }>;

const joined = (parts: SQL[], glue: string) => sql.join(parts.map(part => sql`(${part})`), sql.raw(glue));
const comparisons: Record<string, string> = { equalTo: "=", notEqualTo: "<>", lessThan: "<", lessThanOrEqualTo: "<=", greaterThan: ">", greaterThanOrEqualTo: ">=" };

function condition(column: SQL, kind: FilterKind, operator: string, operand: unknown): SQL {
  if (operator === "isNull") return operand ? sql`${column} IS NULL` : sql`${column} IS NOT NULL`;
  if (operator === "in" || operator === "notIn") {
    const list = sql`(SELECT value FROM json_each(${JSON.stringify((operand as unknown[]).map(item => filterOperand(kind, item)))}))`;
    return operator === "in" ? sql`${column} IN ${list}` : sql`${column} NOT IN ${list}`;
  }
  // instr matches literally: `%` and `_` mean themselves. lower() folds ASCII only.
  if (operator === "includes") return sql`instr(${column}, ${String(operand)}) > 0`;
  if (operator === "includesInsensitive") return sql`instr(lower(${column}), lower(${String(operand)})) > 0`;
  if (operator === "startsWith") return sql`instr(${column}, ${String(operand)}) = 1`;
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

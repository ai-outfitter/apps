/** The text search an entity list takes: terms, quoted phrases, AND, OR, NOT and parentheses.
 * Providers run it in their own database over the fields they declare searchable. */
import { type AnyColumn, and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, not, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { EntityListQuery } from "./entities";

export type SearchExpression = { term: string } | { and: SearchExpression[] } | { or: SearchExpression[] } | { not: SearchExpression };

const invalid = (message: string) => new Response(message, { status: 400 });

/** Uppercase NOT, AND, OR in that precedence; adjacent terms mean AND. */
export function searchExpression(source: string): SearchExpression {
  const tokens = source.match(/"(?:[^"\\]|\\.)*"|\(|\)|[^\s()]+/g) ?? [];
  if (tokens.length > 100) throw invalid("Search exceeds 100 tokens.");
  let index = 0;
  function atom(depth: number): SearchExpression {
    if (depth > 12) throw invalid("Search nesting exceeds 12 levels.");
    const token = tokens[index++];
    if (!token || [")", "AND", "OR"].includes(token)) throw invalid("Expected a search term.");
    if (token === "NOT") return { not: atom(depth + 1) };
    if (token === "(") {
      const expression = either(depth + 1);
      if (tokens[index++] !== ")") throw invalid("Unclosed search parenthesis.");
      return expression;
    }
    if (token.startsWith('"')) return { term: JSON.parse(token) as string };
    if (token.includes('"')) throw invalid("Unclosed quoted phrase.");
    return { term: token };
  }
  function both(depth: number): SearchExpression {
    const values = [atom(depth)];
    while (index < tokens.length && tokens[index] !== ")" && tokens[index] !== "OR") {
      if (tokens[index] === "AND") index++;
      values.push(atom(depth));
    }
    return values.length === 1 ? values[0] : { and: values };
  }
  function either(depth: number): SearchExpression {
    const values = [both(depth)];
    while (tokens[index] === "OR") { index++; values.push(both(depth)); }
    return values.length === 1 ? values[0] : { or: values };
  }
  if (!tokens.length) throw invalid("Search is empty.");
  const expression = either(0);
  if (index !== tokens.length) throw invalid("Unexpected search token.");
  return expression;
}

/** Whether `text` matches: a term is a case-insensitive literal substring. For a provider without SQL. */
export function matchesSearch(expression: SearchExpression, text: string): boolean {
  if ("term" in expression) return text.toLowerCase().includes(expression.term.toLowerCase());
  if ("and" in expression) return expression.and.every(item => matchesSearch(item, text));
  if ("or" in expression) return expression.or.some(item => matchesSearch(item, text));
  return !matchesSearch(expression.not, text);
}

/** The SQL condition for `expression` over `columns`: a term matches when any column holds it as a
 * case-insensitive literal substring ('%' and '_' mean themselves). */
export function searchCondition(expression: SearchExpression, columns: SQLWrapper[]): SQL {
  if ("term" in expression) {
    const term = expression.term.toLowerCase();
    return or(...columns.map(column => sql`instr(lower(coalesce(${column}, '')), ${term}) > 0`)) as SQL;
  }
  if ("and" in expression) return and(...expression.and.map(item => searchCondition(item, columns))) as SQL;
  if ("or" in expression) return or(...expression.or.map(item => searchCondition(item, columns))) as SQL;
  return not(searchCondition(expression.not, columns));
}

/** Bind parameters `searchCondition` uses, for providers under D1's 100-parameter limit. */
export function searchBinds(expression: SearchExpression, columns: number): number {
  if ("term" in expression) return columns;
  if ("not" in expression) return searchBinds(expression.not, columns);
  return ("and" in expression ? expression.and : expression.or).reduce((sum, item) => sum + searchBinds(item, columns), 0);
}

/** The WHERE and ORDER BY a drizzle provider ANDs into its own query for one entity page: the known
 * `ids`, the keyset after the cursor's row, and the requested order (then ID, so pages are stable).
 * `order` maps each advertised order field to its column (`id` is always orderable); `search` lists the
 * columns behind the type's searchFields. */
export function pageCondition(query: EntityListQuery<unknown>, columns: { id: AnyColumn; order?: Record<string, AnyColumn>; search?: SQLWrapper[] }) {
  const column = query.order.field === "id" ? columns.id : columns.order?.[query.order.field];
  if (!column) throw new Response("Unsupported entity ordering", { status: 400 });
  const direction = query.order.direction === "desc" ? desc : asc;
  const beyond = query.order.direction === "desc" ? lt : gt;
  const after = query.after;
  const keyset = !after ? undefined : column === columns.id ? beyond(columns.id, after.id)
    // SQLite sorts NULL first ascending and last descending.
    : after.value === null
      ? query.order.direction === "desc" ? and(isNull(column), beyond(columns.id, after.id)) : or(isNotNull(column), and(isNull(column), gt(columns.id, after.id)))
      : or(beyond(column, after.value), and(eq(column, after.value), beyond(columns.id, after.id)), ...(query.order.direction === "desc" ? [isNull(column)] : []));
  return {
    where: and(query.ids ? inArray(columns.id, query.ids) : undefined, keyset, query.search && columns.search ? searchCondition(query.search, columns.search) : undefined),
    orderBy: column === columns.id ? [direction(columns.id)] : [direction(column), direction(columns.id)],
  };
}

/** searchCondition for a provider writing SQL text: `columns` are trusted column expressions. */
export function searchClause(expression: SearchExpression, columns: string[]): { sql: string; params: string[] } {
  if ("term" in expression) {
    const term = expression.term.toLowerCase();
    return { sql: `(${columns.map(column => `instr(lower(coalesce(${column}, '')), ?) > 0`).join(" OR ")})`, params: columns.map(() => term) };
  }
  if ("not" in expression) {
    const inner = searchClause(expression.not, columns);
    return { sql: `(NOT ${inner.sql})`, params: inner.params };
  }
  const parts = ("and" in expression ? expression.and : expression.or).map(item => searchClause(item, columns));
  return { sql: `(${parts.map(part => part.sql).join("and" in expression ? " AND " : " OR ")})`, params: parts.flatMap(part => part.params) };
}

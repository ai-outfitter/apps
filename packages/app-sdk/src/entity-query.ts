/** The text search an entity list takes: terms, quoted phrases, AND, OR, NOT and parentheses.
 * Providers run it in their own database over the fields they declare searchable. */
import { type AnyColumn, and, asc, desc, not, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { EntityListQuery } from "./entities";
import { foldCase } from "./graph-filter";
import { containsInsensitive, rowsAfter, within } from "./graph-filter-sql";

export type SearchExpression = { term: string } | { and: SearchExpression[] } | { or: SearchExpression[] } | { not: SearchExpression };

/** A 400 for a list request the type does not support. */
export const refuse = (message: string) => new Response(message, { status: 400 });

/** Reads tokens left to right: OR of ANDs of atoms. */
class SearchParser {
  index = 0;
  constructor(readonly tokens: string[]) {}
  either(depth: number): SearchExpression {
    const values = [this.both(depth)];
    while (this.tokens[this.index] === "OR") { this.index++; values.push(this.both(depth)); }
    return values.length === 1 ? values[0] : { or: values };
  }
  both(depth: number): SearchExpression {
    const values = [this.atom(depth)];
    while (this.index < this.tokens.length && this.tokens[this.index] !== ")" && this.tokens[this.index] !== "OR") {
      if (this.tokens[this.index] === "AND") this.index++;
      values.push(this.atom(depth));
    }
    return values.length === 1 ? values[0] : { and: values };
  }
  atom(depth: number): SearchExpression {
    if (depth > 12) throw refuse("Search nesting exceeds 12 levels.");
    const token = this.tokens[this.index++];
    if (!token || [")", "AND", "OR"].includes(token)) throw refuse("Expected a search term.");
    if (token === "NOT") return { not: this.atom(depth + 1) };
    if (token !== "(") return term(token);
    const expression = this.either(depth + 1);
    if (this.tokens[this.index++] !== ")") throw refuse("Unclosed search parenthesis.");
    return expression;
  }
}
/** A bare word, or a phrase in double quotes written as a JSON string. */
function term(token: string): SearchExpression {
  if (!token.includes('"')) return { term: token };
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) throw refuse("Unclosed quoted phrase.");
  try { return { term: JSON.parse(token) as string }; }
  catch { throw refuse('Invalid quoted phrase: write a backslash as \\\\ and a quote as \\", with no tabs or line breaks.'); }
}

/** Uppercase NOT, AND, OR in that precedence; adjacent terms mean AND. */
export function searchExpression(source: string): SearchExpression {
  const tokens = source.match(/"(?:[^"\\]|\\.)*"|\(|\)|[^\s()]+/g) ?? [];
  if (!tokens.length) throw refuse("Search is empty.");
  if (tokens.length > 100) throw refuse("Search exceeds 100 tokens.");
  const parser = new SearchParser(tokens);
  const expression = parser.either(0);
  if (parser.index !== tokens.length) throw refuse("Unexpected search token.");
  return expression;
}

/** Whether `text` matches: a term is a literal substring, ignoring ASCII case. For a provider without SQL. */
export function matchesSearch(expression: SearchExpression, text: string): boolean {
  if ("term" in expression) return foldCase(text).includes(foldCase(expression.term));
  if ("and" in expression) return expression.and.every(item => matchesSearch(item, text));
  if ("or" in expression) return expression.or.some(item => matchesSearch(item, text));
  return !matchesSearch(expression.not, text);
}

/** Between the columns a term is searched in: they are read as one string (a missing column as empty, the unit separator
 * between two), so a term binds once however many columns there are and matches within one column. */
const separator = " || char(31) || ";

/** The SQL condition for `expression` over `columns`: a term matches when any column holds it as a
 * literal substring ('%' and '_' mean themselves), ignoring ASCII case: SQLite folds both sides. */
export function searchCondition(expression: SearchExpression, columns: SQLWrapper[]): SQL {
  const searched = sql.join(columns.map(column => sql`coalesce(${column}, '')`), sql.raw(separator));
  const condition = (item: SearchExpression): SQL => {
    if ("term" in item) return containsInsensitive(searched, item.term);
    if ("and" in item) return and(...item.and.map(condition)) as SQL;
    if ("or" in item) return or(...item.or.map(condition)) as SQL;
    return not(condition(item.not));
  };
  return condition(expression);
}

/** Bind parameters `searchCondition` uses: one per term. */
export function searchBinds(expression: SearchExpression): number {
  if ("term" in expression) return 1;
  if ("not" in expression) return searchBinds(expression.not);
  return ("and" in expression ? expression.and : expression.or).reduce((sum, item) => sum + searchBinds(item), 0);
}
/** Bind parameters a parsed filter may cost its provider: a list is one JSON parameter (`within`, graph-filter-sql), and a
 * value binds at most twice (either end of an edge, or a JSON path beside its value). */
export function filterBinds(filter: unknown): number {
  if (filter === undefined) return 0;
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) return 2;
  return Object.values(filter).reduce((sum: number, value) => sum + filterBinds(value), 0);
}

/** The WHERE and ORDER BY a drizzle provider ANDs into its own query for one entity page: the known
 * `ids` (one bound parameter), the rows after the cursor's row (`rowsAfter`), and the requested order (then ID, so pages are stable).
 * `order` maps each advertised order field to its column (`id` is always orderable); `search` lists the
 * columns behind the type's searchFields. */
export function pageCondition(query: EntityListQuery<unknown>, columns: { id: AnyColumn; order?: Record<string, AnyColumn>; search?: SQLWrapper[] }) {
  const column = query.order.field === "id" ? columns.id : columns.order?.[query.order.field];
  if (!column) throw new Response("Unsupported entity ordering", { status: 400 });
  const direction = query.order.direction === "desc" ? desc : asc;
  return {
    where: and(query.ids ? sql`${columns.id} IN ${within(query.ids)}` : undefined, query.after && rowsAfter(column === columns.id ? null : column, columns.id, query.order.direction === "desc", query.after.value === null ? query.after : { value: column.mapToDriverValue(query.after.value), id: query.after.id }, !column.notNull),
      query.search && columns.search ? searchCondition(query.search, columns.search) : undefined),
    orderBy: column === columns.id ? [direction(columns.id)] : [direction(column), direction(columns.id)],
  };
}
/** searchCondition for a provider writing SQL text: `columns` are trusted column expressions. The term's SQL is
 * `containsInsensitive` spelled as text. */
export function searchClause(expression: SearchExpression, columns: string[]): { sql: string; params: string[] } {
  const searched = columns.map(column => `coalesce(${column}, '')`).join(separator);
  const clause = (item: SearchExpression): { sql: string; params: string[] } => {
    if ("term" in item) return { sql: `(instr(lower(${searched}), lower(?)) > 0)`, params: [item.term] };
    if ("not" in item) {
      const inner = clause(item.not);
      return { sql: `(NOT ${inner.sql})`, params: inner.params };
    }
    const parts = ("and" in item ? item.and : item.or).map(clause);
    return { sql: `(${parts.map(part => part.sql).join("and" in item ? " AND " : " OR ")})`, params: parts.flatMap(part => part.params) };
  };
  return clause(expression);
}

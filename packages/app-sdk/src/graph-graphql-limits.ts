// Bounds on a GraphQL request: query shape before execution, response bytes after.
import { type DocumentNode, type FieldNode, Kind, type SelectionSetNode } from "graphql";

type Measure = { fields: number; depth: number };
/** Introspection is allowed and shallow types nest deeply, so it has its own depth. */
const introspectionDepth = 20;

const zero: Measure = { fields: 0, depth: 0 };
const isIntrospection = (name: string) => name === "__schema" || name === "__type";

/** Selected fields (fragments counted per use) and deepest field path, outside introspection. */
export function measureQuery(document: DocumentNode, operationName?: string, cap = Number.MAX_SAFE_INTEGER): Measure {
  const fragments = new Map(document.definitions.flatMap(definition => definition.kind === Kind.FRAGMENT_DEFINITION ? [[definition.name.value, definition.selectionSet] as const] : []));
  const memo = new Map<string, Measure>();
  const visiting = new Set<string>();
  function field(selection: FieldNode, introspection: boolean): Measure {
    const root = !introspection && isIntrospection(selection.name.value);
    const below = selection.selectionSet ? measure(selection.selectionSet, introspection || root) : zero;
    // An introspection root counts as one level; below it only its own depth bound applies.
    if (!root) return { fields: below.fields + 1, depth: below.depth + 1 };
    return { fields: below.fields + 1, depth: below.depth > introspectionDepth ? Number.MAX_SAFE_INTEGER : 1 };
  }
  function spread(name: string, introspection: boolean) {
    const key = `${introspection}:${name}`;
    const set = fragments.get(name);
    if (memo.has(key) || !set || visiting.has(key)) return memo.get(key) ?? zero;
    visiting.add(key);
    const result = measure(set, introspection);
    visiting.delete(key);
    memo.set(key, result);
    return result;
  }
  function measure(set: SelectionSetNode, introspection: boolean): Measure {
    const total = { ...zero };
    for (const selection of set.selections) {
      const inner = selection.kind === Kind.FIELD ? field(selection, introspection)
        : selection.kind === Kind.INLINE_FRAGMENT ? measure(selection.selectionSet, introspection) : spread(selection.name.value, introspection);
      total.fields = Math.min(cap, total.fields + inner.fields);
      total.depth = Math.max(total.depth, inner.depth);
    }
    return total;
  }
  const operations = document.definitions.flatMap(definition =>
    definition.kind === Kind.OPERATION_DEFINITION && (!operationName || definition.name?.value === operationName) ? [definition] : []);
  return operations.reduce((total, operation) => {
    const found = measure(operation.selectionSet, false);
    return { fields: Math.min(cap, total.fields + found.fields), depth: Math.max(total.depth, found.depth) };
  }, zero);
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
type Found = { list: unknown[]; path: (string | number)[]; size: number; parent: Record<string, unknown> | null };
function lists(value: unknown, path: (string | number)[] = [], parent: Record<string, unknown> | null = null, into: Found[] = []) {
  if (Array.isArray(value)) {
    if (value.length) into.push({ list: value, path, size: bytes(value), parent });
    for (const [index, item] of value.entries()) lists(item, [...path, index], null, into);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) lists(item, [...path, key], value as Record<string, unknown>, into);
  }
  return into;
}

const isPageInfo = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && ("hasNextPage" in value || "endCursor" in value);

/** Cut the largest lists from the end until the response fits; records are never cut.
 * A cut connection's pageInfo (under any alias) continues after the last record kept;
 * `cursorAt(path, kept)` gives that cursor for the connection at `path`. */
export function fitResponse(response: { data: unknown }, maxBytes: number, cursorAt: (path: (string | number)[], kept: number) => string | null) {
  const paths: (string | number)[][] = [];
  let size = bytes(response);
  while (size > maxBytes) {
    const found = lists(response.data).sort((a, b) => b.size - a.size)[0];
    if (!found) break;
    // Keep as many leading items as fit; at least drop one so the loop ends.
    const sizes = found.list.map(item => bytes(item) + 1);
    let keep = found.list.length - 1, saved = sizes[keep];
    while (keep > 0 && size - saved > maxBytes) saved += sizes[--keep];
    found.list.length = keep;
    paths.push(found.path);
    for (const pageInfo of Object.values(found.parent ?? {}).filter(isPageInfo)) {
      if ("hasNextPage" in pageInfo) pageInfo.hasNextPage = true;
      if ("endCursor" in pageInfo) pageInfo.endCursor = cursorAt(found.path.slice(0, -1), keep);
    }
    size = bytes(response);
  }
  return paths;
}
export const responseBytes = bytes;

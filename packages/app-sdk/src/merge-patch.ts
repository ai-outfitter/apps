import { canonicalActionValue } from "./actions";
import { sha256Hex } from "./server";

/**
 * Merge patches over an app's own state: the caller reads the state, sends only
 * what it changes, and the app applies the patch, validates the whole result
 * and writes it. Values replace, `null` removes, a missing key adds (RFC 7386).
 * Collections are keyed maps, `{ key: value | null }`, so one entry changes
 * without restating the rest. What the state holds and what makes it valid stay
 * in the app.
 */
export type MergePatch = { [key: string]: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** RFC 7386: apply `patch` over `target` without changing either. */
export function applyMergePatch<T>(target: T, patch: unknown): T {
  if (!isObject(patch)) return patch as T;
  const result: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (value !== undefined) result[key] = applyMergePatch(result[key], value);
  }
  return result as T;
}

export type KeyedChange<T, P> =
  | { key: string; change: "add"; patch: P }
  | { key: string; change: "update"; before: T; patch: P }
  | { key: string; change: "remove"; before: T };

/** What a keyed-map patch does to each entry it names, in key order. A `null` for
 * a key that is not there is refused: the caller read a different state. */
export function keyedChanges<T, P>(current: Record<string, T>, patch: Record<string, P | null> | undefined): KeyedChange<T, P>[] {
  return Object.entries(patch ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flatMap(([key, value]): KeyedChange<T, P>[] => {
    const before = Object.hasOwn(current, key) ? current[key] : undefined;
    if (value === undefined) return [];
    if (value === null) {
      if (before === undefined) throw new Response(`Nothing to remove at ${key}`, { status: 409 });
      return [{ key, change: "remove", before }];
    }
    return before === undefined ? [{ key, change: "add", patch: value }] : [{ key, change: "update", before, patch: value }];
  });
}

/** The revision of a state as served: a digest of its canonical JSON, so any change
 * to what the caller read changes it. */
export async function stateRevision(state: unknown) {
  return (await sha256Hex(`state/v1:${canonicalActionValue(state)}`)).slice(0, 32);
}

/** Refuse a patch built on a state that has since changed. */
export function requireRevision(expected: string, current: string) {
  if (expected !== current)
    throw new Response("The state changed since it was read. Read it again and rebuild the patch.", { status: 409 });
}

/** Turns a title into a key: lowercase words joined by hyphens. */
export function slugify(text: string) {
  return text.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

/** Readable, unique keys for records: each record's slug (or its title as a slug),
 * or its id when two records would share a key or it has neither. Sorted by id
 * first so the same records always get the same keys. */
export function slugKeys<R>(records: R[], identify: (record: R) => { id: string; slug?: string | null; title?: string | null }) {
  const rows = records.map((record) => ({ record, ...identify(record) })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const wanted = rows.map((row) => (row.slug?.trim() || slugify(row.title ?? "")) || row.id);
  const counts = new Map<string, number>();
  for (const key of wanted) counts.set(key, (counts.get(key) ?? 0) + 1);
  const keys = new Map<string, R>();
  for (const [index, row] of rows.entries()) keys.set(counts.get(wanted[index]) === 1 ? wanted[index] : row.id, row.record);
  return keys;
}

/** A keyed set as served: `{ key: true }` for each key. */
export const keySet = (keys: Iterable<string>) => Object.fromEntries([...keys].sort().map((key) => [key, true as const]));

/** The keys a keyed set holds after `patch`: `true` adds, `null` removes. */
export function patchKeySet(current: Iterable<string>, patch: Record<string, true | null> | undefined) {
  const keys = new Set(current);
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) keys.delete(key);
    else keys.add(key);
  }
  return [...keys].sort();
}

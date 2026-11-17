import { core } from "../lib/graph";
type Row = { id: unknown; typeId?: unknown; archived?: unknown; properties?: unknown };
/** A portable import may contain owner context, but must not make an exact
 * organization binding newly ambiguous. Existing legacy ambiguity is not repaired. */
export function rejectNewOwnerBindingAmbiguity(before: Row[], after: Row[]) {
  const bindings = (rows: Row[]) => {
    const result = new Map<string, Set<string>>();
    for (const row of rows) {
      if (row.typeId !== core.organization || row.archived === true || row.archived === 1) continue;
      const props = typeof row.properties === "string" ? JSON.parse(row.properties) : row.properties;
      const key = (props as Record<string, unknown> | null)?.organization_id;
      if (typeof key !== "string" || !key) continue;
      const ids = result.get(key) ?? new Set<string>(); ids.add(String(row.id)); result.set(key, ids);
    }
    return result;
  };
  const prior = bindings(before);
  for (const [key, ids] of bindings(after)) {
    if (ids.size > 1 && [...ids].some(id => !prior.get(key)?.has(id)))
      throw new Response("Import would create ambiguous organization owner bindings; reconcile the existing and imported canonical roots explicitly before importing", { status: 409 });
  }
}

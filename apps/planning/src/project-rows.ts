// Client-safe: the projects page script and its server render share this grouping.
type Row = { name: string; organizationSlug?: string | null };

/** The projects list's rows: the member's own projects first, then one row per organization. */
export function projectRows<T extends Row>(projects: T[]) {
  const rows = new Map<string, T[]>();
  for (const project of projects) {
    const key = project.organizationSlug ?? "";
    rows.set(key, [...(rows.get(key) ?? []), project]);
  }
  return [...rows].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([key, items]) => ({ key, label: key || "Personal", projects: items.sort((x, y) => x.name.localeCompare(y.name)) }));
}

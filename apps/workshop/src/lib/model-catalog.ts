import { bomTotals, type Assembly, type Item } from './assembly';

/** One entry per definition, including parts not yet placed in the root assembly. */
export function modelCatalog(assembly: Assembly, search = '', kind = 'all') {
  const quantities = new Map(bomTotals(assembly).lines.map(row => [row.item.id, row.quantity]));
  if (assembly.rootId) quantities.set(assembly.rootId, 1);
  const byId = new Map(assembly.items.map(item => [item.id, item]));
  const modeled = (item: Item): boolean => Boolean(item.geometry || item.mesh || item.uses.some(use => {
    const child = byId.get(use.itemId);
    return child && modeled(child);
  }));
  const query = search.trim().toLowerCase();
  return assembly.items.map(item => ({ item, quantity: quantities.get(item.id) ?? 0, modeled: modeled(item) }))
    .filter(row => (!query || [row.item.name, row.item.number, row.item.manufacturer, row.item.mpn].join(' ').toLowerCase().includes(query))
      && (kind === 'all' || (kind === 'modeled' ? row.modeled : kind === 'unmodeled' ? !row.modeled : row.item.kind === kind)))
    .sort((a, b) => Number(b.item.kind === 'assembly') - Number(a.item.kind === 'assembly') || a.item.number.localeCompare(b.item.number));
}

/** A view rooted at one definition; never changes the saved assembly or placements. */
export function modelView(assembly: Assembly, itemId?: string | null): Assembly {
  return itemId && assembly.items.some(item => item.id === itemId) ? { ...assembly, rootId: itemId } : assembly;
}

/** Immediate children, aggregated by definition while retaining placement labels. */
export function assemblyChildren(assembly: Assembly, parentId = assembly.rootId) {
 const byId = new Map(assembly.items.map(item => [item.id, item]));
 const rows = new Map<string, {item: Item; quantity: number; labels: string[]}>();
 for (const use of byId.get(parentId ?? '')?.uses ?? []) {
  const item = byId.get(use.itemId);
  if (!item) continue;
  const row = rows.get(item.id) ?? {item, quantity: 0, labels: []};
  row.quantity += use.quantity;
  if (use.refdes) row.labels.push(use.refdes);
  rows.set(item.id, row);
 }
 return [...rows.values()];
}

/** A deterministic shortest path; shared definitions can also have other parents. */
export function assemblyPath(assembly: Assembly, targetId = assembly.rootId): Item[] {
 const byId = new Map(assembly.items.map(item => [item.id, item]));
 const root = byId.get(assembly.rootId ?? '');
 if (!root) return [];
 const queue: Item[][] = [[root]], visited = new Set<string>();
 for (let index = 0; index < queue.length; index++) {
  const path = queue[index], item = path.at(-1)!;
  if (item.id === targetId) return path;
  if (visited.has(item.id)) continue;
  visited.add(item.id);
  for (const use of item.uses) {
   const child = byId.get(use.itemId);
   if (child) queue.push([...path, child]);
  }
 }
 const target = byId.get(targetId ?? '');
 return target ? [target] : [];
}

import type { Item } from "../lib/assembly";
import type { AssemblySource } from "../lib/assembly-resolution";
import type { CotsEvidenceRef } from "../lib/cots-evidence";

export type CotsSourceLoader = (ref: {projectId: string; revision?: number}) => Promise<AssemblySource>;
export const cotsOwnerFailure = (message: string, status = 400) => new Response(message, { status });

export async function cotsPart(load: CotsSourceLoader, ref: CotsEvidenceRef) {
  const source = await load({ projectId: ref.projectId, revision: ref.revision });
  const item = source.assembly.items.find(item => item.id === ref.itemId && item.kind === "cots");
  if (!item) throw cotsOwnerFailure("Purchased part is unavailable", 404);
  return { source, item, owner: {
    projectId: source.id, itemId: item.id, revision: source.revision, name: item.name,
    number: item.number, partRevision: item.revision,
  } };
}

function samePart(left: Item, right: Item) {
  const normalize = (value: string) => value.trim().toLowerCase();
  if (left.revision !== right.revision || normalize(left.manufacturer) !== normalize(right.manufacturer)) return false;
  if (left.mpn || right.mpn) return Boolean(left.manufacturer) && normalize(left.mpn) === normalize(right.mpn);
  return left.number === right.number;
}

export async function canonicalCotsPart(load: CotsSourceLoader, ref: CotsEvidenceRef) {
  let current = await cotsPart(load, ref);
  const visited = new Set<string>();
  while (current.item.cotsEvidenceRef) {
    const key = JSON.stringify([current.owner.projectId, current.owner.itemId, current.owner.revision]);
    if (visited.has(key) || visited.size >= 16) throw cotsOwnerFailure("COTS evidence reference cycle or depth limit");
    visited.add(key);
    const next = await cotsPart(load, current.item.cotsEvidenceRef);
    if (!samePart(current.item, next.item)) throw cotsOwnerFailure("Evidence owner identifies a different purchased part or part revision", 409);
    current = next;
  }
  return current;
}

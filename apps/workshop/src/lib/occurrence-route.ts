import type { Assembly, Item } from "./assembly";
import { projectPath } from "./sections";

const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const identifierPattern = new RegExp(`^${uuid}$`);
const segmentPattern = new RegExp(`^(${uuid})~(0|[1-9][0-9]{0,2})$`);

export function componentIdentity(item: Item) {
  const number = identifierPattern.test(item.number) ? "" : item.number;
  const name = identifierPattern.test(item.name) ? "" : item.name;
  return { name: name || number || (item.kind === "cots" ? "Purchased part" : item.kind[0].toUpperCase() + item.kind.slice(1)), number };
}

export function occurrenceAddress(path: string) {
  return path.split("/").slice(1).map(segment => segment.replace("#", "~")).join("/");
}

export function occurrenceUrl(slug: string, address: string, query: URLSearchParams) {
  return projectPath(slug) + (address ? "/inspect/" + address : "") + (query.size ? "?" + query : "");
}

/** Resolve against the selected assembly root. An item ID cannot identify an installation. */
export function occurrenceTrail(assembly: Pick<Assembly, "rootId" | "items">, address: string) {
  const items = new Map(assembly.items.map(item => [item.id, item]));
  let item = items.get(assembly.rootId ?? "");
  if (!item) return undefined;
  const trail: { item: Item; path: string; address: string }[] = [{ item, path: item.id, address: "" }];
  for (const segment of address ? address.split("/") : []) {
    const match = segmentPattern.exec(segment);
    if (!match) return undefined;
    const [, id, copy] = match;
    const use = item.uses.find(use => use.id === id);
    if (!use || Number(copy) >= use.quantity) return undefined;
    item = items.get(use.itemId);
    if (!item) return undefined;
    const parent = trail.at(-1)!;
    trail.push({ item, path: parent.path + "/" + id + "#" + copy, address: [parent.address, segment].filter(Boolean).join("/") });
  }
  return trail;
}

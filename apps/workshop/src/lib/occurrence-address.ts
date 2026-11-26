import type { Assembly } from "./assembly";
import { projectPath } from "./sections";

const segment = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})~(0|[1-9][0-9]{0,2})$/i;

export function parentPath(path: string) {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

export function occurrenceAddress(path: string) {
  return path.split("/").slice(1).map(part => part.replace("#", "~")).join("/");
}

export function occurrencePath(root: string, address: string) {
  if (!address) return root;
  const parts = address.split("/");
  if (!parts.every(part => segment.test(part))) return undefined;
  return root + "/" + parts.map(part => part.replace("~", "#")).join("/");
}

export function levelPath(slug: string, path: string) {
  const address = occurrenceAddress(path);
  return projectPath(slug) + (address ? "/assembly/" + address : "");
}

/** Walk just the addressed chain. The usage ID is local to its parent. */
export function addressedLevel(assembly: Assembly, root: string, address: string) {
  const byId = new Map(assembly.items.map(item => [item.id, item]));
  const first = byId.get(root);
  if (!first || !address) return undefined;
  const chain = [{ item: first, path: root, copy: 0, quantity: 1 }];
  for (const part of address.split("/")) {
    const match = segment.exec(part);
    if (!match) return undefined;
    const parent = chain.at(-1)!;
    const usage = parent.item.uses.find(use => use.id === match[1]);
    const item = usage && byId.get(usage.itemId);
    const copy = Number(match[2]);
    if (!usage || !item || copy >= usage.quantity) return undefined;
    chain.push({ item, path: parent.path + "/" + usage.id + "#" + copy, copy, quantity: usage.quantity });
  }
  return chain.at(-1)!.item.uses.length ? chain : undefined;
}

export function displayName(item: { id: string; name: string; number: string; kind: string }) {
  const isId = (value: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  const number = isId(item.number) ? "" : item.number;
  return { name: (isId(item.name) ? number : item.name) || (item.kind === "assembly" ? "Unnamed assembly" : "Unnamed component"), number };
}

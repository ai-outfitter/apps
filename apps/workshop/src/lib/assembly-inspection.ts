import { Box3, Matrix4, Quaternion, Vector3 } from "three";
import { displayName, parentPath } from "./occurrence-address";
import { placements, worldCorners, type Assembly, type Item, type Usage } from "./assembly";

export type Occurrence = {
  item: Item; path: string; matrix: Matrix4; usage?: Usage; children: Occurrence[]; bounds: Box3; label: string;
};

export function inspectionOccurrences(assembly: Assembly) {
  const occurrences = new Map<string, Occurrence>();
  const solids = placements(assembly, { onVisit(item, path, matrix, usage) {
    const parent = occurrences.get(parentPath(path));
    const copy = Number(path.split("#").at(-1));
    const { name } = displayName(item);
    const reference = usage?.refdes === name ? "" : usage?.refdes;
    const label = [name, reference, usage && usage.quantity > 1 ? "copy " + (copy + 1) : ""].filter(Boolean).join(" · ");
    const occurrence = { item, path, matrix, usage, children: [], bounds: new Box3(), label };
    occurrences.set(path, occurrence);
    parent?.children.push(occurrence);
  } });
  for (const solid of solids) {
    const bounds = occurrences.get(solid.path)!.bounds;
    for (const point of worldCorners(solid)) bounds.expandByPoint(new Vector3(...point));
  }
  for (const occurrence of [...occurrences.values()].reverse()) {
    occurrences.get(parentPath(occurrence.path))?.bounds.union(occurrence.bounds);
    const counts = new Map<string, number>();
    for (const child of occurrence.children) counts.set(child.label,(counts.get(child.label) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const child of occurrence.children) {
      if (counts.get(child.label)! < 2) continue;
      const index = (seen.get(child.label) ?? 0) + 1;
      seen.set(child.label,index);
      child.label += " · instance " + index;
    }
  }
  return occurrences;
}

export function immediatePath(level: string, path: string) {
  if (!path.startsWith(level + "/")) return undefined;
  const end = path.indexOf("/", level.length + 1);
  return end < 0 ? path : path.slice(0, end);
}

export function inspectionOffsets(level: Occurrence, amount: number) {
  const offsets = new Map<string, Vector3>();
  const rotation = new Quaternion().setFromRotationMatrix(level.matrix);
  const steps = Math.max(1, ...level.children.map(child => child.usage?.explode?.step ?? 1));
  const interval = (child: Occurrence) => {
    const z = child.matrix.elements[14];
    return child.bounds.isEmpty() ? { low: z, high: z } : { low: child.bounds.min.z, high: child.bounds.max.z };
  };
  // Keep authored vectors in the parent frame. Auto separation packs the
  // immediate units by their assembled world height, using bounds of each
  // entire subtree. Stable ties retain assembly order (including copy index).
  const automatic = level.children.filter(child => !child.usage?.explode)
    .map(child => ({ child, ...interval(child) }))
    .sort((a, b) => (a.low + a.high) - (b.low + b.high));
  const gap = Math.max(10, level.bounds.getSize(new Vector3()).length() * 0.08);
  const anchor = Math.floor((automatic.length - 1) / 2);
  if (automatic.length) {
    const { child, low, high } = automatic[anchor];
    offsets.set(child.path, new Vector3());
    const progress = Math.max(0, Math.min(1, amount / 100 * steps));
    for (let i = anchor + 1, edge = high; i < automatic.length; i++) {
      const row = automatic[i];
      const dz = Math.max(gap, edge + gap - row.low);
      offsets.set(row.child.path, new Vector3(0, 0, dz * progress));
      edge = row.high + dz;
    }
    for (let i = anchor - 1, edge = low; i >= 0; i--) {
      const row = automatic[i];
      const dz = Math.min(-gap, edge - gap - row.high);
      offsets.set(row.child.path, new Vector3(0, 0, dz * progress));
      edge = row.low + dz;
    }
  }
  for (const child of level.children) {
    const authored = child.usage?.explode;
    if (!authored) continue;
    const progress = Math.max(0, Math.min(1, amount / 100 * steps - ((authored.step ?? 1) - 1)));
    offsets.set(child.path, new Vector3(...authored.offset).applyQuaternion(rotation).multiplyScalar(progress));
  }
  return offsets;
}

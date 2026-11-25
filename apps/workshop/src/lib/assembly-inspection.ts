import { Box3, Matrix4, Quaternion, Vector3 } from "three";
import { componentIdentity } from "./occurrence-route";
import { placements, worldCorners, type Assembly, type Item, type Usage } from "./assembly";

export type Occurrence = {
  item: Item; path: string; matrix: Matrix4; usage?: Usage; children: Occurrence[]; bounds: Box3; label: string;
};

export function inspectionOccurrences(assembly: Assembly) {
  const occurrences = new Map<string, Occurrence>();
  const solids = placements(assembly, { onVisit(item, path, matrix, usage) {
    const parent = occurrences.get(parentPath(path));
    const copy = Number(path.split("#").at(-1));
    const label = [usage?.refdes, componentIdentity(item).name, usage && usage.quantity > 1 ? String(copy + 1) : ""].filter(Boolean).join(" · ");
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
export function parentPath(path: string) { return path.slice(0, Math.max(0, path.lastIndexOf("/"))); }

export function immediatePath(level: string, path: string) {
  if (!path.startsWith(level + "/")) return undefined;
  const end = path.indexOf("/", level.length + 1);
  return end < 0 ? path : path.slice(0, end);
}

export function inspectionOffsets(level: Occurrence, amount: number) {
  const offsets = new Map<string, Vector3>();
  const rotation = new Quaternion().setFromRotationMatrix(level.matrix);
  const steps = Math.max(1, ...level.children.map(child => child.usage?.explode?.step ?? 1));
  const automatic: { child: Occurrence; min: number; max: number }[] = [];
  const fixed: { min: number; max: number }[] = [];
  for (const child of level.children) {
    const authored = child.usage?.explode;
    const z = child.matrix.elements[14];
    const min = child.bounds.isEmpty() ? z : child.bounds.min.z;
    const max = child.bounds.isEmpty() ? z : child.bounds.max.z;
    if (authored) {
      const progress = Math.max(0, Math.min(1, amount / 100 * steps - ((authored.step ?? 1) - 1)));
      const delta = new Vector3(...authored.offset).applyQuaternion(rotation);
      fixed.push({ min: min + delta.z, max: max + delta.z });
      offsets.set(child.path, delta.multiplyScalar(progress));
    } else automatic.push({ child, min, max });
  }

  // Pack the installed units in their assembled vertical order, retaining authored
  // sibling order for ties. Center the added separation around the assembled stack.
  const gap = Math.max(10, level.bounds.getSize(new Vector3()).z * 0.12);
  automatic.sort((a, b) => (a.min + a.max) - (b.min + b.max));
  const shifts: number[] = [];
  let previousTop = -Infinity;
  for (const [index, unit] of automatic.entries()) {
    const shift = Math.max((shifts[index - 1] ?? 0) + (index ? gap : 0), previousTop + gap - unit.min);
    shifts.push(shift);
    previousTop = unit.max + shift;
  }
  const center = (shifts.at(-1) ?? 0) / 2;
  fixed.sort((a, b) => a.min - b.min);
  previousTop = -Infinity;
  for (const [index, { child, min, max }] of automatic.entries()) {
    let shift = Math.max(shifts[index] - center, previousTop + gap - min);
    for (const obstacle of fixed) {
      if (max + shift + gap <= obstacle.min) break;
      shift = Math.max(shift, obstacle.max + gap - min);
    }
    previousTop = max + shift;
    offsets.set(child.path, new Vector3(0, 0, amount ? shift * amount / 100 : 0));
  }
  return offsets;
}

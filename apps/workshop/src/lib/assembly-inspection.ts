import { Box3, Matrix4, Quaternion, Vector3 } from "three";
import { placements, worldCorners, type Assembly, type Item, type Usage } from "./assembly";

export type Occurrence = {
  item: Item; path: string; matrix: Matrix4; usage?: Usage; children: Occurrence[]; bounds: Box3; label: string;
};

export function inspectionOccurrences(assembly: Assembly) {
  const occurrences = new Map<string, Occurrence>();
  const solids = placements(assembly, { onVisit(item, path, matrix, usage) {
    const parent = occurrences.get(parentPath(path));
    const copy = Number(path.split("#").at(-1));
    const label = [usage?.refdes, item.name, usage && usage.quantity > 1 ? String(copy + 1) : ""].filter(Boolean).join(" · ");
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
function parentPath(path: string) { return path.slice(0, Math.max(0, path.lastIndexOf("/"))); }

export function immediatePath(level: string, path: string) {
  if (!path.startsWith(level + "/")) return undefined;
  const end = path.indexOf("/", level.length + 1);
  return end < 0 ? path : path.slice(0, end);
}

export function inspectionOffsets(level: Occurrence, amount: number) {
  const offsets = new Map<string, Vector3>();
  const center = level.bounds.getCenter(new Vector3());
  const distance = Math.max(10, level.bounds.getSize(new Vector3()).length() * 0.52);
  const rotation = new Quaternion().setFromRotationMatrix(level.matrix);
  const steps = Math.max(1, ...level.children.map(child => child.usage?.explode?.step ?? 1));
  const directions: Vector3[] = [];
  for (const [index, child] of level.children.entries()) {
    const authored = child.usage?.explode;
    const progress = Math.max(0, Math.min(1, amount / 100 * steps - ((authored?.step ?? 1) - 1)));
    let delta: Vector3;
    if (authored) delta = new Vector3(...authored.offset).applyQuaternion(rotation);
    else {
      delta = child.bounds.getCenter(new Vector3()).sub(center).normalize();
      if (!delta.lengthSq() || directions.some(prior => prior.dot(delta) > 0.98)) {
        const angle = index * Math.PI * (3 - Math.sqrt(5));
        delta.set(Math.cos(angle), Math.sin(angle), index % 2 ? 0.5 : -0.5).normalize().applyQuaternion(rotation);
      }
      directions.push(delta.clone());
      delta.multiplyScalar(distance);
    }
    offsets.set(child.path, delta.multiplyScalar(progress));
  }
  return offsets;
}

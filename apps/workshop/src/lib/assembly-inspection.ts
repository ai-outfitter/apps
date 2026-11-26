import { Box3, MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import { placements, worldCorners, type Assembly, type Item, type Usage } from "./assembly";

export type Occurrence = {
  item: Item; path: string; matrix: Matrix4; usage?: Usage; rigid: boolean; children: Occurrence[]; bounds: Box3; label: string;
};

export function inspectionOccurrences(assembly: Assembly) {
  const occurrences = new Map<string, Occurrence>();
  const solids = placements(assembly, { onVisit(item, path, matrix, usage) {
    const parent = occurrences.get(parentPath(path));
    const copy = Number(path.split("#").at(-1));
    const label = [usage?.refdes, item.name, usage && usage.quantity > 1 ? String(copy + 1) : ""].filter(Boolean).join(" · ");
    const rigid = Boolean(parent?.rigid || usage?.explode?.rigid);
    const occurrence = { item, path, matrix, usage, rigid, children: [], bounds: new Box3(), label };
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
  if (level.rigid) return offsets;
  const rotation = new Quaternion().setFromRotationMatrix(level.matrix);
  if (level.children.some(child => child.usage?.explode)) {
    const steps = Math.max(1, ...level.children.map(child => child.usage?.explode?.step ?? 1));
    for (const child of level.children) {
      const authored = child.usage?.explode;
      if (!authored?.offset) continue;
      const progress = MathUtils.clamp(amount / 100 * steps - ((authored.step ?? 1) - 1), 0, 1);
      offsets.set(child.path, new Vector3(...authored.offset).applyQuaternion(rotation).multiplyScalar(progress));
    }
    return offsets;
  }

  const center = level.bounds.getCenter(new Vector3());
  const distance = Math.max(10, level.bounds.getSize(new Vector3()).length() * 0.52);
  const progress = MathUtils.clamp(amount / 100, 0, 1);
  const directions: Vector3[] = [];
  for (const [index, child] of level.children.entries()) {
    const delta = child.bounds.getCenter(new Vector3()).sub(center).normalize();
    if (!delta.lengthSq() || directions.some(prior => prior.dot(delta) > 0.98)) {
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      delta.set(Math.cos(angle), Math.sin(angle), index % 2 ? 0.5 : -0.5).normalize().applyQuaternion(rotation);
    }
    directions.push(delta.clone());
    offsets.set(child.path, delta.multiplyScalar(distance * progress));
  }
  return offsets;
}

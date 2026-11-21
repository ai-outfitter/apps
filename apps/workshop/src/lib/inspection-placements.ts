import { Matrix4 } from "three";
import { assemblyBounds, placements, type Assembly } from "./assembly";
import { jointMatrix } from "./installed-operations";
import type { Joint } from "./operation-schema";

export type Hinge = { path: string; rest: Matrix4; joint: Joint & { openDegrees: number } };
export function inspectionPlacements(view: Assembly) {
  const hinges = new Map<string, Hinge>();
  const instances = new Map<string, { path: string; label: string }[]>();
  const labels = new Map<string, string>();
  const solids = placements(view, {
    onVisit(item, path, rest, usage) {
      const parent = labels.get(path.slice(0, path.lastIndexOf("/")));
      const part = usage?.refdes || item.name;
      const copy = usage && usage.quantity > 1 ? " " + (Number(path.split("#").at(-1)) + 1) : "";
      const label = (parent ? parent + " / " : "") + part + copy;
      labels.set(path, usage ? label : "");
      const list = instances.get(item.id) ?? [];
      list.push({ path, label });
      instances.set(item.id, list);
      if (usage?.joint?.openDegrees !== undefined) {
        hinges.set(path, { path, rest, joint: { ...usage.joint, openDegrees: usage.joint.openDegrees } });
      }
    },
  });
  return { instances, hinges, bounds: assemblyBounds(solids) };
}

// Combine view-only opening angles with the pose computed for this instant.
// Descendant hinges apply first so an opened child travels with its parent.
export function hingeTransforms(open: Iterable<Hinge>, pose?: Map<string, Matrix4>) {
  return Array.from(open, (hinge) => {
    const frame = pose?.get(hinge.path) ?? hinge.rest;
    return {
      path: hinge.path,
      delta: frame
        .clone()
        .multiply(jointMatrix(hinge.joint, hinge.joint.openDegrees))
        .multiply(frame.clone().invert()),
    };
  }).sort((a, b) => b.path.length - a.path.length);
}

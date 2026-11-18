import { placements, worldCorners } from "./assembly";
import type { Project } from "./project";
import { boxPlan, planBounds } from "../model/cad-plan";

/** An isometric drawing of saved component envelopes when no capture exists. */
export function projectThumbnail(project: Project) {
  // Copies within one usage share a transform and project to the same outline.
  const assembly = project.assembly;
  const solids = assembly ? placements({ ...assembly, items: assembly.items.map(item => ({
    ...item, uses: item.uses.map(use => ({ ...use, quantity: 1 })),
  })) }).map(worldCorners) : [];
  if (!solids.length) {
    const {width, depth, height} = project.params;
    const {min, max} = planBounds(project.cadPlan ?? boxPlan(width, depth, height));
    solids.push([min[0],max[0]].flatMap(x => [min[1],max[1]].flatMap(y => [min[2],max[2]].map(z => [x,y,z]))));
  }
  const boxes = solids.sort((a,b) => a[0][0]+a[0][1]+a[0][2]-b[0][0]-b[0][1]-b[0][2])
    .map(box => box.map(([x,y,z]) => [(x-y)*0.866,(x+y)*0.5-z]));
  const points = boxes.flat();
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  const width = Math.max(1,Math.max(...xs)-x), height = Math.max(1,Math.max(...ys)-y);
  const pad = Math.max(width,height)*0.08;
  const faces = [[4,6,7,5],[2,6,7,3],[1,3,7,5]];
  const colors = ["#65817b","#97aaa1","#d1dcd2"];
  const polygons = boxes.flatMap(box => faces.map((face,i) =>
    `<polygon points="${face.map(n=>box[n].map(v=>v.toFixed(2)).join(",")).join(" ")}" fill="${colors[i]}" stroke="#445e59" stroke-width=".55" vector-effect="non-scaling-stroke"/>`));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x-pad} ${y-pad} ${width+2*pad} ${height+2*pad}">${polygons.join("")}</svg>`;
}

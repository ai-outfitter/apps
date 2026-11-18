import { placements, worldCorners } from "./assembly";
import type { Project } from "./project";
import { boxPlan, planBounds } from "../model/cad-plan";

/** An isometric drawing of saved component envelopes when no capture exists. */
export function projectThumbnail(project: Project) {
  // Copies within one usage share a transform and project to the same outline.
  const solids = placements(project.assembly, { maxVisits: 512, skipCoincidentCopies: true }).map(worldCorners);
  if (!solids.length) {
    const {width, depth, height} = project.params;
    const {min, max} = planBounds(project.cadPlan ?? boxPlan(width, depth, height));
    solids.push([min[0],max[0]].flatMap(x => [min[1],max[1]].flatMap(y => [min[2],max[2]].map(z => [x,y,z]))));
  }
  const projectPoint = ([x,y,z]: number[]) => [(x-y)*0.866,(x+y)*0.5-z];
  const projected = solids.flat().map(projectPoint);
  const xs = projected.map(p => p[0]), ys = projected.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  const width = Math.max(1,Math.max(...xs)-x), height = Math.max(1,Math.max(...ys)-y);
  const pad = Math.max(width,height)*0.08;
  const faces = [[0,2,3,1],[4,6,7,5],[0,4,5,1],[2,6,7,3],[0,2,6,4],[1,3,7,5]];
  const colors = ["#65817b","#97aaa1","#d1dcd2"];
  // Paint far faces first, including the opposite faces of rotated boxes.
  const polygons = solids.flatMap(box => faces.map((indices,i) => {
    const vertices = indices.map(index => box[index]);
    const depth = vertices.reduce((sum,[x,y,z]) => sum+x+y+z, 0);
    const points = vertices.map(point => projectPoint(point).map(v=>v.toFixed(2)).join(",")).join(" ");
    return { depth, svg: `<polygon points="${points}" fill="${colors[Math.floor(i/2)]}" stroke="#445e59" stroke-width=".55" vector-effect="non-scaling-stroke"/>` };
  })).sort((a,b)=>a.depth-b.depth);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x-pad} ${y-pad} ${width+2*pad} ${height+2*pad}">${polygons.map(p=>p.svg).join("")}</svg>`;
}

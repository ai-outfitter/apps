import {Matrix4,Vector3} from 'three';
import {SavedDriveMotionSchema, type SavedRotation, type DriveMotion} from './drive-motion-schema';
export {SavedDriveMotionSchema} from './drive-motion-schema';
import {placements,type Assembly,type Placement} from './assembly';

export type PlacedRotation=SavedRotation & {path:string};

/** Validate references against the complete build before resolving a focused view. */
export function savedDriveMotion(value:unknown,assembly:Assembly,view:Assembly) {
 const spec=SavedDriveMotionSchema.parse(value);
 const uses=new Map(assembly.items.flatMap(item=>item.uses.map(use=>[use.id,use] as const)));
 const byId=new Map(assembly.items.map(item=>[item.id,item]));
 if(spec.viewRootIds.some(id=>!byId.has(id)))throw Error('Motion view is absent from this build');
 for(const id of spec.z.translationUsageIds)if(!uses.has(id))throw Error('Motion translation usage is absent from this build');
 for(const rotation of spec.z.rotations){
  const use=uses.get(rotation.usageId),item=use&&byId.get(use.itemId);
  if(!item || item.uses.length || !(item.geometry||item.mesh))throw Error('Motion rotation must reference a saved leaf solid');
 }
 if(!spec.viewRootIds.includes(view.rootId??''))return;
 return bindMotion(spec,placements(view));
}

function bindMotion(spec:DriveMotion,list:Placement[]) {
 const paths=new Set(list.filter(p=>spec.z.translationUsageIds.some(id=>p.path.includes(`/${id}#`))).map(p=>p.path));
 const rotations:PlacedRotation[]=spec.z.rotations.flatMap(rotation=>list.filter(p=>new RegExp(`/${rotation.usageId}#\\d+$`).test(p.path)).map(p=>({...rotation,path:p.path})));
 if(!paths.size || !rotations.length)throw Error('Motion metadata does not address visible saved solids');
 return {levels:spec.z.levels,paths,rotations};
}

/** Bind authored motion only to installed instances visible in this view. */
export function installedDriveMotion(view: Assembly) {
 const owners = view.items.filter(item=>item.driveMotion);
 if (!owners.length) return;
 const mounts: {spec: DriveMotion; path: string; axis: Vector3}[] = [];
 const list = placements(view,{onVisit(item,path,matrix) {
   const spec = item.driveMotion ?? (item.id===view.rootId ? owners.find(o=>o.driveMotion!.viewRootIds.includes(item.id))?.driveMotion : undefined);
   if (spec?.viewRootIds.includes(item.id))
     mounts.push({spec,path,axis:new Vector3(0,0,1).transformDirection(matrix)});
 }});
 if (!mounts.length) return;
 const levels=mounts[0].spec.z.levels;
 const paths=new Set<string>(), rotations:PlacedRotation[]=[], axes=new Map<string,Vector3>();
 for (const mount of mounts) {
   if (JSON.stringify(mount.spec.z.levels)!==JSON.stringify(levels)) throw Error("Select a drive assembly to play its distinct motion levels");
   const local=bindMotion(mount.spec,list.filter(p=>p.path.startsWith(mount.path+"/")));
   for (const path of local.paths) { paths.add(path); axes.set(path,mount.axis); }
   rotations.push(...local.rotations);
 }
 return {levels,paths,rotations,axes};
}

/** Apply local shaft rotation then world Z displacement to the saved placement. */
export function savedMotionMatrix(rest:Matrix4,offset:number,translate:boolean,rotations:SavedRotation[],target=new Matrix4(),axis?:Vector3) {
 target.copy(rest);
 for(const rotation of rotations){
  const [x,y,z]=rotation.pivot;
  target.multiply(new Matrix4().makeTranslation(x,y,z))
   .multiply(new Matrix4().makeRotationAxis(new Vector3(...rotation.axis),offset*rotation.radiansPerMillimeter))
   .multiply(new Matrix4().makeTranslation(-x,-y,-z));
 }
 if(translate){
  target.elements[12]+=offset*(axis?.x??0);
  target.elements[13]+=offset*(axis?.y??0);
  target.elements[14]+=offset*(axis?.z??1);
 }
 return target;
}

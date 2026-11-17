import {Matrix4,Vector3} from 'three';
import {z} from 'zod';
import {placements,type Assembly} from './assembly';

const vector=z.tuple([z.number(),z.number(),z.number()]);
const rotation=z.object({
 usageId:z.uuid(),axis:vector.refine(v=>Math.abs(Math.hypot(...v)-1)<1e-6,'Rotation axis must be unit length'),
 pivot:vector,radiansPerMillimeter:z.number().refine(n=>n!==0),
}).strict();
/** Build-owned movement instructions. This schema defines no geometry or joints. */
export const SavedDriveMotionSchema=z.object({
 version:z.literal(1),viewRootIds:z.array(z.uuid()).min(1).max(20),
 z:z.object({
  levels:z.array(z.object({label:z.string().min(1).max(100),offset:z.number()}).strict()).min(2).max(16).refine(levels=>levels.every((level,i)=>i===0||level.offset>levels[i-1].offset),"Motion levels must strictly increase"),
  translationUsageIds:z.array(z.uuid()).min(1).max(200),rotations:z.array(rotation).min(1).max(100),
 }).strict(),
}).strict();
export type SavedRotation=z.infer<typeof rotation>;
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
 const list=placements(view);
 const paths=new Set(list.filter(p=>spec.z.translationUsageIds.some(id=>p.path.includes(`/${id}#`))).map(p=>p.path));
 const rotations:PlacedRotation[]=spec.z.rotations.flatMap(rotation=>list.filter(p=>new RegExp(`/${rotation.usageId}#\\d+$`).test(p.path)).map(p=>({...rotation,path:p.path})));
 if(!paths.size || !rotations.length)throw Error('Motion metadata does not address visible saved solids');
 return {levels:spec.z.levels,paths,rotations};
}

/** Apply local shaft rotation then world Z displacement to the saved placement. */
export function savedMotionMatrix(rest:Matrix4,offset:number,translate:boolean,rotations:SavedRotation[],target=new Matrix4()) {
 target.copy(rest);
 for(const rotation of rotations){
  const [x,y,z]=rotation.pivot;
  target.multiply(new Matrix4().makeTranslation(x,y,z))
   .multiply(new Matrix4().makeRotationAxis(new Vector3(...rotation.axis),offset*rotation.radiansPerMillimeter))
   .multiply(new Matrix4().makeTranslation(-x,-y,-z));
 }
 if(translate)target.elements[14]+=offset;
 return target;
}

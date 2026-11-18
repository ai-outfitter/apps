import {z} from 'zod';
const vector=z.tuple([z.number(),z.number(),z.number()]);
const rotation=z.object({
 usageId:z.uuid(),axis:vector.refine(v=>Math.abs(Math.hypot(...v)-1)<1e-6,'Rotation axis must be unit length'),
 pivot:vector,radiansPerMillimeter:z.number().refine(n=>n!==0),
}).strict();
/** Saved movement instructions. This schema defines no geometry or joints. */
export const SavedDriveMotionSchema=z.object({
 version:z.literal(1),viewRootIds:z.array(z.uuid()).min(1).max(20),
 z:z.object({
  levels:z.array(z.object({label:z.string().min(1).max(100),offset:z.number()}).strict()).min(2).max(16).refine(levels=>levels.every((level,i)=>i===0||level.offset>levels[i-1].offset),"Motion levels must strictly increase"),
  translationUsageIds:z.array(z.uuid()).min(1).max(200),rotations:z.array(rotation).min(1).max(100),
 }).strict(),
}).strict();
export type SavedRotation=z.infer<typeof rotation>;
export type DriveMotion = z.infer<typeof SavedDriveMotionSchema>;

import { z } from "zod";

const vector = z.tuple([z.number(), z.number(), z.number()]);
export const JointSchema = z.object({
  kind: z.enum(["prismatic", "revolute"]),
  axis: vector.refine(v => Math.abs(Math.hypot(...v) - 1) < 1e-6, "Joint axis must be a unit vector"),
  pivot: vector.optional(),
}).strict();
const segment = /^([0-9a-f-]{36})#(0|[1-9]\d*)$/i;
const path = z.string().min(1).refine(value => value.split("/").every(part => {
  const match = segment.exec(part);
  return match && z.uuid().safeParse(match[1]).success && Number.isSafeInteger(Number(match[2]));
}), "Use slash-separated usageUUID#copy segments");
const key = z.object({time:z.number().nonnegative(), value:z.number()}).strict();
export const OperationSchema = z.object({
  name:z.string().trim().min(1).max(100),
  durationSeconds:z.number().positive(),
  tracks:z.array(z.object({path, keys:z.array(key).min(2)}).strict()).min(1),
  handoffs:z.array(z.object({time:z.number().nonnegative(), propPath:path, carrierPath:path.optional()}).strict()).optional(),
}).strict().superRefine((op, ctx) => {
  const fail = (message:string) => ctx.addIssue({code:"custom",message});
  if (new Set(op.tracks.map(t=>t.path)).size !== op.tracks.length) fail("Duplicate operation track");
  for (const {keys} of op.tracks) {
    if (keys[0].time !== 0 || keys[0].value !== 0 || keys.some((k,i)=>k.time > op.durationSeconds || (i>0 && k.time<=keys[i-1].time)))
      fail("Joint keys must start at rest and advance within the duration");
  }
  const events = op.handoffs ?? [];
  const props = new Set(events.map(e=>e.propPath));
  const under = (p:string, root:string) => p===root || p.startsWith(root+"/");
  const last = new Map<string,number>();
  for (const e of events) {
    if (e.time > op.durationSeconds || e.time <= (last.get(e.propPath) ?? -1)) fail("Prop events must advance within the duration");
    last.set(e.propPath,e.time);
    for (const prop of props) {
      if ((e.carrierPath && under(e.carrierPath,prop)) || (prop!==e.propPath && under(e.propPath,prop)))
        fail("Props cannot contain another prop or carrier");
    }
  }
});
export type Operation = z.infer<typeof OperationSchema>;
export type Joint = z.infer<typeof JointSchema>;

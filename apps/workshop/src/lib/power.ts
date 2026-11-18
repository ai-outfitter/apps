import { z } from "zod";
import type { Assembly } from "./assembly";

const key = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const watts = z.number().min(0).max(1e7).nullable();
export const PowerValuesSchema = z.object({ averageW: watts, operatingW: watts, peakW: watts }).strict()
  .refine(v => v.peakW === null || [v.averageW, v.operatingW].every(n => n === null || n <= v.peakW!), "Running peak must cover average and operating demand");
export const PowerLoadSchema = z.object({
  id: key, name: z.string().min(1).max(150), rail: key,
  evidence: z.enum(["assumed", "modeled", "vendor", "measured"]),
  source: z.string().min(1).max(2000), notes: z.string().max(3000),
  scenarios: z.record(key, PowerValuesSchema),
}).strict();
export const ItemPowerSchema = z.object({
  // Only this item's own loads. Child totals and converter input are derived.
  loads: z.array(PowerLoadSchema).max(30),
}).strict();
export const PowerSystemSchema = z.object({
  version: z.literal(1),
  scenarios: z.array(z.object({id:key, name:z.string().min(1).max(150), notes:z.string().max(5000)}).strict()).min(1).max(20),
  rails: z.array(z.object({
    id:key, name:z.string().min(1).max(100), voltage:z.number().positive().max(10000),
    kind:z.enum(["ac","dc"]), parent:key.optional(),
    efficiency:z.number().positive().max(1), notes:z.string().max(2000),
  }).strict()).min(1).max(30),
  notes:z.string().max(8000),
}).strict().superRefine((p,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:"custom",message});
  const rails=new Map(p.rails.map(r=>[r.id,r]));
  if(rails.size!==p.rails.length)fail("Duplicate power rail");
  if(new Set(p.scenarios.map(s=>s.id)).size!==p.scenarios.length)fail("Duplicate power scenario");
  if(p.rails.filter(r=>!r.parent).length!==1)fail("Power rails must have one source boundary");
  for(const rail of p.rails){
    if(!rail.parent && rail.efficiency!==1)fail("Source boundary efficiency must be one");
    const seen=new Set<string>();let current:typeof rail|undefined=rail;
    while(current){
      if(seen.has(current.id)){fail("Power rail cycle");break;}
      seen.add(current.id);
      if(current.parent && !rails.has(current.parent)){fail("Missing parent power rail");break;}
      current=current.parent?rails.get(current.parent):undefined;
    }
  }
});
export type PowerValues=z.infer<typeof PowerValuesSchema>;
export type PowerSystem=z.infer<typeof PowerSystemSchema>;
export type PowerLoad=z.infer<typeof PowerLoadSchema>;
const fields=["averageW","operatingW","peakW"] as const;
const zero=():PowerValues=>({averageW:0,operatingW:0,peakW:0});
function add(a:PowerValues,b:PowerValues,factor=1){for(const f of fields)a[f]=a[f]===null||b[f]===null?null:a[f]!+b[f]!*factor;}
export function validateAssemblyPower(a:Assembly,ctx:z.RefinementCtx){
  const fail=(message:string)=>ctx.addIssue({code:"custom",message});
  const loads=a.items.flatMap(i=>(i.power?.loads??[]).map(l=>({item:i,load:l})));
  if(!a.power){if(loads.length)fail("Power loads require assembly rails and scenarios");return;}
  const rails=new Set(a.power.rails.map(r=>r.id)),scenarios=new Set(a.power.scenarios.map(s=>s.id));
  for(const item of a.items)if(new Set(item.power?.loads.map(l=>l.id)).size!==(item.power?.loads.length??0))fail(`Duplicate load on ${item.number}`);
  for(const {item,load} of loads){
    if(!rails.has(load.rail))fail(`Unknown rail on ${item.number}`);
    if(Object.keys(load.scenarios).some(s=>!scenarios.has(s)) || [...scenarios].some(s=>!(s in load.scenarios)))fail(`Load scenarios must match assembly scenarios on ${item.number}`);
  }
}
/** Input demand for one instance of the selected item. Rail rows are nested,
 * never additive: total is exclusively the single source-boundary row. */
export function powerRollup(a:Assembly,scenario:string,rootId=a.rootId){
  if(!a.power || !rootId)return undefined;
  if(!a.power.scenarios.some(s=>s.id===scenario))throw Error("Unknown power scenario");
  const byId=new Map(a.items.map(i=>[i.id,i]));
  const rails=new Map(a.power.rails.map(r=>[r.id,{...r,values:zero()}]));
  const rows:{itemId:string; number:string; itemName:string; load:PowerLoad; quantity:number; values:PowerValues}[]=[];
  const quantities=new Map<string,number>();
  const walk=(id:string,qty:number,path:Set<string>)=>{
    if(path.has(id))throw Error("Assembly cycle");
    const item=byId.get(id);if(!item)throw Error("Missing assembly item");
    const next=new Set(path).add(id);quantities.set(id,(quantities.get(id)??0)+qty);
    for(const u of item.uses)walk(u.itemId,qty*u.quantity,next);
  };
  walk(rootId,1,new Set());
  for(const [id,qty] of quantities){
    const item=byId.get(id)!;
    for(const load of item.power?.loads??[]){
      const values=zero();add(values,load.scenarios[scenario],qty);
      rows.push({itemId:id,number:item.number,itemName:item.name,load,quantity:qty,values});
      let rail=rails.get(load.rail),factor=1;
      while(rail){add(rail.values,values,factor);factor/=rail.efficiency;rail=rail.parent?rails.get(rail.parent):undefined;}
    }
  }
  const boundary=[...rails.values()].find(r=>!r.parent)!;
  const unrecorded=[...quantities].reduce((n,[id,qty])=>n+(byId.get(id)!.kind!=="assembly"&&!byId.get(id)!.power?.loads.length?qty:0),0);
  return {unrecorded,rows,rails:[...rails.values()],boundary,total:boundary.values,dailyWh:boundary.values.averageW===null?null:boundary.values.averageW*24};
}

import { and, eq } from "drizzle-orm";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import type { PlanningDatabase } from "./planning";
import { priorityOrder } from "./schema";

export const orderInput = z.strictObject({kind:z.enum(["projects","products"]), items:z.array(z.uuid()).max(500), revision:z.number().int().nonnegative()});
export async function readOrder(db:PlanningDatabase, identity:AppIdentity, kind:"projects"|"products") {
  if (!identity.organizationId) throw new Response("An organization scope is required",{status:400});
  const [row]=await db.select().from(priorityOrder).where(and(eq(priorityOrder.installationId,identity.installationId),eq(priorityOrder.kind,kind)));
  return {items:row ? JSON.parse(row.items) as string[] : [], revision:row?.revision ?? 0};
}
export async function saveOrder(db:PlanningDatabase, identity:AppIdentity, raw:unknown, allowed:readonly string[]) {
  requireEditor(identity);
  const input=orderInput.parse(raw);
  if(!identity.organizationId) throw new Response("An organization scope is required",{status:400});
  if(new Set(input.items).size!==input.items.length || input.items.some(id=>!allowed.includes(id)) || input.items.length!==allowed.length) throw new Response("Reload the complete list before reordering",{status:409});
  const key=and(eq(priorityOrder.installationId,identity.installationId),eq(priorityOrder.kind,input.kind));
  if(input.revision===0) {
    const rows=await db.insert(priorityOrder).values({installationId:identity.installationId,kind:input.kind,items:JSON.stringify(input.items),revision:1}).onConflictDoNothing().returning();
    if(!rows.length)throw new Response("Order changed; reload before retrying",{status:409});
  } else {
    const rows=await db.update(priorityOrder).set({items:JSON.stringify(input.items),revision:input.revision+1}).where(and(key,eq(priorityOrder.revision,input.revision))).returning();
    if(!rows.length)throw new Response("Order changed; reload before retrying",{status:409});
  }
  return {items:input.items,revision:input.revision+1};
}
export function sortByOrder<T>(items:T[],order:readonly string[],id:(item:T)=>string):T[] {
  const positions=new Map(order.map((value,index)=>[value,index]));
  return [...items].sort((a,b)=>(positions.get(id(a))??Number.MAX_SAFE_INTEGER)-(positions.get(id(b))??Number.MAX_SAFE_INTEGER)||id(a).localeCompare(id(b)));
}

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireEditor } from "@ai-outfitter/app-sdk/server";
import type { PlanningContext } from "./intake";
import { priorityOrder } from "./schema";
import type { PlanningDatabase } from "./planning";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
export async function storedPersonalPriorities(db:PlanningDatabase, identity:AppIdentity) {
  if(identity.organizationId)throw new Response("Personal priorities require personal scope",{status:403});
  const rows=await db.select().from(priorityOrder).where(eq(priorityOrder.installationId,identity.installationId));
  const items=(selected:string)=>{const row=rows.find(row=>row.kind===selected);return row?z.array(z.string()).parse(JSON.parse(row.items)):[];};
  return {organizations:items("portfolio-organizations"),projects:items("portfolio-projects")};
}

export type PortfolioContext = Pick<PlanningContext, "identity" | "db" | "host">;

const kind = z.enum(["organizations", "projects"]);
export const portfolioOrderInput = z.strictObject({
  kind,
  items: z.array(z.string().min(1).max(300)).max(500),
  revision: z.number().int().nonnegative(),
});
const organization = z.object({ slug: z.string(), name: z.string().nullable().optional() });
const project = z.object({ id: z.uuid(), name: z.string(), organizationSlug: z.string().nullable().optional(), state: z.string(), archived: z.boolean() });

function personal(context: PortfolioContext) {
  if (context.identity.organizationId) throw new Response("Open your personal Planning installation", { status: 403 });
}

/** Resolve the allowed set through the member's live authorization, never from submitted IDs. */
export async function portfolioItems(context: PortfolioContext, selected: z.infer<typeof kind>) {
  personal(context);
  if (selected === "organizations") {
    const value = await context.host().call("platform.document", { document: "Viewer", kind: "query", variables: {}, query: "query { viewer { orgs { slug name } } }" }).catch(async error => { if(error instanceof Response)throw new Error(await error.text());throw error; });
    return z.object({ viewer: z.object({ orgs: z.array(organization) }) }).parse(value).viewer.orgs
      .map(row => ({ id: row.slug, name: row.name ?? row.slug }));
  }
  const rows: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  const identities = new Set<string>();
  do {
    if (++pages > 100) throw new Response("Portfolio read exceeded its page budget; retry with a smaller portfolio", { status: 422 });
    const value = await context.host().call("platform.document", {
      document: "PortfolioProjects", app: "planning", kind: "query", variables: { limit: 100, ...(cursor ? { cursor } : {}) },
    });
    const result = z.object({ data: z.object({ projects: z.array(project) }), next: z.string().optional() }).parse(value);
    for (const row of result.data.projects) {
      const id = `${row.organizationSlug || "personal"}:${row.id}`;
      if (!row.archived && !identities.has(id)) { identities.add(id); rows.push({ id, name: row.name }); }
    }
    cursor = result.next;
    if (cursor && seen.has(cursor)) throw new Response("Portfolio pagination did not advance; retry the read", { status: 502 });
    if (cursor) seen.add(cursor);
    if (rows.length > 500) throw new Response("Portfolio exceeds the supported ordering size", { status: 422 });
  } while (cursor);
  return rows;
}

function key(context: PortfolioContext, selected: z.infer<typeof kind>) {
  return and(eq(priorityOrder.installationId, context.identity.installationId), eq(priorityOrder.kind, `portfolio-${selected}`));
}

export async function personalPortfolio(context: PortfolioContext, selected: z.infer<typeof kind>) {
  personal(context);
  const available = await portfolioItems(context, selected);
  const [saved] = await context.db().select().from(priorityOrder).where(key(context, selected));
  const allowed = new Set(available.map(row => row.id));
  const stored = saved ? z.array(z.string()).parse(JSON.parse(saved.items)) : [];
  // Revocation removes references from responses without changing the saved order or its CAS revision.
  const items = stored.filter(id => allowed.has(id));
  const included = new Set(items);
  items.push(...available.map(row => row.id).filter(id => !included.has(id)));
  const labels = new Map(available.map(row => [row.id, row.name]));
  return { kind: selected, revision: saved?.revision ?? 0, items, records: items.map(id => ({ id, name: labels.get(id)! })) };
}

export async function reorderPersonalPortfolio(context: PortfolioContext, raw: unknown) {
  personal(context);
  requireEditor(context.identity);
  const input = portfolioOrderInput.parse(raw);
  const available = await portfolioItems(context, input.kind);
  const allowed = new Set(available.map(row => row.id));
  if (new Set(input.items).size !== input.items.length || input.items.length !== allowed.size || input.items.some(id => !allowed.has(id))) {
    throw new Response("Reload the complete authorized portfolio before reordering", { status: 409 });
  }
  const values = { items: JSON.stringify(input.items), revision: input.revision + 1 };
  const changed = input.revision === 0
    ? await context.db().insert(priorityOrder).values({ ...values, installationId: context.identity.installationId, kind: `portfolio-${input.kind}` }).onConflictDoNothing().returning()
    : await context.db().update(priorityOrder).set(values).where(and(key(context, input.kind), eq(priorityOrder.revision, input.revision))).returning();
  if (!changed.length) throw new Response("Portfolio order changed; reload before retrying", { status: 409 });
  return { kind: input.kind, items: input.items, revision: values.revision };
}

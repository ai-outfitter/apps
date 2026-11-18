// Design partners' requests. A design partner is a customer with a flag: in this
// organization's own graph, a `customer_of` link from the customer's Organization
// node to this organization's node with `design_partner: true`, each node bound to
// its platform organization by `organization_id`. Only design partners file here,
// from their own organization (graph_mutate with fromScope, role external); other
// customers file issues on the public repository.
//
// A call from another organization has no workflow host scope, so it cannot read
// this graph: editors refresh a small cache of the partners (RefreshDesignPartners),
// which a partner's SubmitPartnerRequest checks. The graph stays canonical, and
// accepting reads it again. Accepting files the request with Software Foundry's
// RequestChanges, as the accepting editor, with the partner named in the problem:
// Foundry attributes a request only to a member.
import { type TableContext } from "@ai-outfitter/app-sdk/app-graphql";
import { queryWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import type { GraphQueryInput, GraphQueryResult } from "@ai-outfitter/app-sdk/graph-query";
import { isRetired } from "@ai-outfitter/app-sdk/knowledge-graph";
import { requireEditor } from "@ai-outfitter/app-sdk/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { appCall, appInstallation } from "./delivery-prepare";
import type { PlanningContext } from "./intake";
import { designPartners, type PartnerRequest, partnerRequests } from "./schema";

type Context = PlanningContext & TableContext;
const conflict = (text: string) => new Response(text, { status: 409 });
const LIMIT = 200;

/** One graph.query read: bound Organization nodes, customer links that carry the flag and, on acceptance, the product. */
export function designPartnerQuery(productId?: string): GraphQueryInput {
  return {
    includeTypes: "none",
    maxBytes: 64 * 1024,
    queries: [
      { name: "bound", entity: "node", types: ["Organization"], text: "organization_id", fields: ["title", "properties", "validity"], limit: LIMIT },
      { name: "customers", entity: "edge", types: ["customer_of"], text: "design_partner", fields: ["properties", "validity"], limit: LIMIT },
      ...(productId ? [{ name: "product", entity: "node" as const, ids: [productId], fields: ["title", "validity"] as string[], limit: 1 }] : []),
    ],
  };
}

type Row = { id: string; title?: unknown; archived?: unknown; retired?: unknown; properties?: Record<string, unknown> | null;
  validity?: { from?: string | null; to?: string | null } | null; fromId?: unknown; toId?: unknown };
const current = (row: Row, now: number) => {
  if (row.archived || row.retired || isRetired(row)) return false;
  const from = row.validity?.from ? Date.parse(row.validity.from) : null;
  const to = row.validity?.to ? Date.parse(row.validity.to) : null;
  return (from === null || from <= now) && (to === null || now < to);
};

export type DesignPartner = { organizationId: string; name: string };

/** The organization a node stands for, when it is the one current node bound to it. */
function boundOrganizations(result: GraphQueryResult, now: number) {
  const bound = new Set(result.queries.bound?.matches ?? []);
  const nodes = new Map<string, DesignPartner>();
  const nodesFor = new Map<string, number>();
  for (const node of result.nodes as Row[]) {
    const id = node.properties?.organization_id;
    if (!bound.has(node.id) || !current(node, now) || typeof id !== "string" || !id.trim()) continue;
    nodes.set(node.id, { organizationId: id, name: typeof node.title === "string" ? node.title : id });
    nodesFor.set(id, (nodesFor.get(id) ?? 0) + 1);
  }
  return (nodeId: unknown) => {
    const node = nodes.get(String(nodeId));
    return node && nodesFor.get(node.organizationId) === 1 ? node : null;
  };
}
/** The organizations this graph records as design partners of `organizationId`, sorted; null when the read was cut
 * short. A node stands for an organization only when it is the one current node bound to it. */
export function designPartnersIn(result: GraphQueryResult, organizationId: string, now = Date.now()): DesignPartner[] | null {
  if (!result.complete) return null;
  const unique = boundOrganizations(result, now);
  const links = new Set(result.queries.customers?.matches ?? []);
  const found = new Map<string, DesignPartner>();
  for (const edge of result.edges as Row[]) {
    if (!links.has(edge.id) || !current(edge, now) || edge.properties?.design_partner !== true) continue;
    const customer = unique(edge.fromId);
    if (customer && customer.organizationId !== organizationId && unique(edge.toId)?.organizationId === organizationId) found.set(customer.organizationId, customer);
  }
  return [...found.values()].sort((a, b) => a.organizationId.localeCompare(b.organizationId));
}

/** Read the graph (the editor's own access), replace the cache and return the partners and the product. */
async function readPartners(context: Context, productId?: string) {
  const result = await queryWikiGraph(context.host(), designPartnerQuery(productId));
  const partners = designPartnersIn(result, context.identity.organizationId ?? "");
  if (!partners) throw conflict("The graph's customer records did not fit one read");
  const { installationId } = context.identity;
  const now = Date.now();
  await context.store().batch([
    { sql: "DELETE FROM planning_design_partners WHERE installationId=?", params: [installationId] },
    ...partners.map(row => ({ sql: "INSERT INTO planning_design_partners(installationId,organizationId,name,refreshedAt) VALUES(?,?,?,?)", params: [installationId, row.organizationId, row.name, now] })),
  ]);
  const product = (result.nodes as Row[]).find(node => node.id === productId && result.queries.product?.matches.includes(node.id) && current(node, now));
  return {
    partners,
    product: product ? { installationId: result.wiki.installationId, type: "graph-node", id: product.id, title: String(product.title ?? product.id).slice(0, 200) } : null,
  };
}

const organizationOnly = (context: Context) => {
  if (!context.identity.organizationId || context.identity.owner.kind !== "organization")
    throw new Response("Design partners file with an organization's Planning", { status: 403 });
};

export const refreshPartnersInput = z.strictObject({});
/** RefreshDesignPartners: editors re-read the design partners from the graph. */
export async function refreshDesignPartners(context: Context) {
  requireEditor(context.identity);
  organizationOnly(context);
  return { designPartners: (await readPartners(context)).partners };
}

// The brief Foundry's RequestChanges takes (kind, title, problem, acceptance criteria with ids, bug details), so an
// accepted request reaches Foundry unchanged apart from the attribution line.
const criterionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const partnerRequestInput = z.strictObject({
  requestId: z.uuid().transform(value => value.toLowerCase()).describe("Your ID for the request. Replay it to read the request's current status; changed content conflicts."),
  kind: z.enum(["feature", "bug"]).describe("feature: new or changed behavior. bug: existing behavior that is wrong; needs bug details."),
  title: z.string().trim().min(1).max(200),
  problem: z.string().trim().min(1).max(16000).describe("What your users cannot do today, or what goes wrong, and why it matters."),
  acceptanceCriteria: z.array(z.strictObject({ id: criterionId, text: z.string().trim().min(1).max(2000) })).min(1).max(50),
  bug: z.strictObject({
    stepsToReproduce: z.array(z.string().trim().min(1).max(2000)).min(1).max(50),
    expected: z.string().trim().min(1).max(4000), actual: z.string().trim().min(1).max(4000), environment: z.string().trim().max(2000).optional(),
  }).optional().describe("Bugs only."),
  productId: z.string().trim().min(1).max(200).optional()
    .describe("The provider's product the request concerns: the record ID your graph's copy of that product shares with the provider's."),
}).superRefine((input, context) => {
  if (input.kind === "bug" && !input.bug) context.addIssue({ code: "custom", path: ["bug"], message: "bug requests need bug details" });
  if (input.kind === "feature" && input.bug) context.addIssue({ code: "custom", path: ["bug"], message: "only bug requests carry bug details" });
  const ids = input.acceptanceCriteria.map(criterion => criterion.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["acceptanceCriteria"], message: "criterion ids must be unique" });
});
type Brief = Omit<z.output<typeof partnerRequestInput>, "requestId">;
type Submitter = { organizationId: string; userId: string; actor: unknown };

/** What the partner and editors read back. */
export function partnerRequestView(row: PartnerRequest) {
  const brief = JSON.parse(row.brief) as Brief;
  const submitter = JSON.parse(row.submitter) as Submitter;
  return {
    id: row.id, requestId: row.requestId, revision: row.revision, status: row.status, ...brief, bug: brief.bug ?? null, productId: brief.productId ?? null,
    partner: { organizationId: row.partnerOrganizationId, userId: submitter.userId, role: "design partner" },
    reason: row.reason, foundryRequest: row.foundryRequest ? JSON.parse(row.foundryRequest) : null,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

/** SubmitPartnerRequest: a design partner's member files from their own organization. A replay with the same
 * requestId returns the request with its current status; different content is a 409. */
export async function submitPartnerRequest(context: Context, input: z.output<typeof partnerRequestInput>) {
  const { identity } = context;
  const partner = identity.callerOrganizationId;
  if (identity.role !== "external" || !partner)
    throw new Response("SubmitPartnerRequest is for design partners calling from their own organization (graph_mutate with fromScope). Members of this organization file requests with Software Foundry's RequestChanges.", { status: 403 });
  organizationOnly(context);
  const db = context.db();
  const [listed] = await db.select().from(designPartners).where(and(eq(designPartners.installationId, identity.installationId), eq(designPartners.organizationId, partner)));
  if (!listed) throw new Response("Only this organization's design partners submit requests here; other customers file an issue on the public repository. A new design partner can submit once an editor refreshes the list (RefreshDesignPartners).", { status: 403 });
  const { requestId, ...brief } = input;
  const where = and(eq(partnerRequests.installationId, identity.installationId), eq(partnerRequests.partnerOrganizationId, partner), eq(partnerRequests.requestId, requestId));
  const same = (row: PartnerRequest) => JSON.stringify(JSON.parse(row.brief)) === JSON.stringify(brief);
  const [existing] = await db.select().from(partnerRequests).where(where);
  if (existing) {
    if (!same(existing)) throw conflict("This requestId already names a different request");
    return partnerRequestView(existing);
  }
  const now = Date.now();
  const submitter: Submitter = { organizationId: partner, userId: identity.userId, actor: context.actor };
  await db.insert(partnerRequests).values({
    id: crypto.randomUUID(), installationId: identity.installationId, partnerOrganizationId: partner, requestId,
    submitter: JSON.stringify(submitter), brief: JSON.stringify(brief), createdBy: identity.userId, updatedBy: identity.userId, createdAt: now, updatedAt: now,
  }).onConflictDoNothing();
  // A concurrent first attempt may have won the insert.
  const [row] = await db.select().from(partnerRequests).where(where);
  if (!row || !same(row)) throw conflict("This requestId already names a different request");
  return partnerRequestView(row);
}

const decision = z.strictObject({ id: z.uuid(), revision: z.number().int().positive().describe("The revision you read; a changed request is refused (409).") });
export const acceptPartnerRequestInput = decision.extend({
  target: z.strictObject({
    repository: z.string().trim().min(3).max(200).optional().describe("owner/name of a repository Foundry may work on."),
    project: z.string().trim().min(1).max(128).optional().describe("A Foundry project to route to."),
  }).refine(target => target.repository || target.project, "Name a repository or a Foundry project")
    .describe("Where Foundry should open the issue, as RequestChanges takes it."),
});
export const rejectPartnerRequestInput = decision.extend({ reason: z.string().trim().min(1).max(2000).describe("The partner reads this with its request.") });

async function proposed(context: Context, input: z.output<typeof decision>) {
  const [row] = await context.db().select().from(partnerRequests)
    .where(and(eq(partnerRequests.installationId, context.identity.installationId), eq(partnerRequests.id, input.id)));
  if (!row) throw new Response("Partner request not found", { status: 404 });
  if (row.revision !== input.revision) throw conflict("The request changed; read it again");
  if (row.status !== "proposed") throw conflict(`The request is already ${row.status}`);
  return row;
}
async function decide(context: Context, row: PartnerRequest, values: Partial<PartnerRequest>) {
  const [saved] = await context.db().update(partnerRequests)
    .set({ ...values, decidedBy: context.identity.userId, updatedBy: context.identity.userId, updatedAt: Date.now(), revision: row.revision + 1 })
    .where(and(eq(partnerRequests.id, row.id), eq(partnerRequests.revision, row.revision), eq(partnerRequests.status, "proposed"))).returning();
  if (!saved) throw conflict("The request changed; read it again");
  return partnerRequestView(saved);
}

/** Foundry's published RequestChanges document; the platform runs only a destination's published documents, so this
 * text must stay the one software-foundry ships (tests/partner-requests.unit.test.ts checks it). */
export const requestChangesDocument = `mutation RequestChanges($input: RequestChangesInput!) {
  requestChanges(input: $input) {
    items {
      key
      status
      result
      error
    }
    instructions {
      code
      itemKey
      actor
      required
      message
      call
      taskId
      url
    }
  }
}`;
const receipt = z.object({
  items: z.array(z.object({ key: z.string(), status: z.string(), result: z.unknown().optional(), error: z.object({ code: z.string().optional(), message: z.string().optional() }).nullish() })),
});
const submitted = z.object({ id: z.string(), kind: z.string(), issue: z.object({ number: z.number(), url: z.string() }) }).passthrough();

/** AcceptPartnerRequest: an editor accepts. The graph must still flag the partner; Foundry then files the request as
 * a GitHub issue, attributed to the accepting editor, with the partner named first in the problem and the product,
 * when the graph has it, in the context. A refusal leaves the request proposed; Foundry is idempotent on the
 * request's ID, so a retry finds the issue an earlier attempt opened. */
export async function acceptPartnerRequest(context: Context, input: z.output<typeof acceptPartnerRequestInput>) {
  requireEditor(context.identity);
  organizationOnly(context);
  const row = await proposed(context, input);
  const brief = JSON.parse(row.brief) as Brief;
  const { partners, product } = await readPartners(context, brief.productId);
  const partner = partners.find(item => item.organizationId === row.partnerOrganizationId);
  if (!partner) throw new Response("The graph no longer records this organization as a design partner", { status: 403 });
  const foundry = await appInstallation(context, "software-foundry", "Software Foundry");
  if (!foundry.installationId) throw conflict(foundry.blocker ?? "Install Software Foundry first");
  const submitter = JSON.parse(row.submitter) as Submitter;
  const attribution = `Filed by design partner ${partner.name} (organization ${partner.organizationId}, user ${submitter.userId})${product ? ` for ${product.title}` : ""}.`;
  const request = {
    // The request's own ID: Foundry keys its record by it and the accepting editor, so a retry resumes it.
    requestId: row.id, kind: brief.kind, title: brief.title, problem: `${attribution}\n\n${brief.problem}`,
    acceptanceCriteria: brief.acceptanceCriteria, ...(brief.bug ? { bug: brief.bug } : {}), target: input.target, context: product ? [product] : [],
  };
  // Batch keys are never retried, so each attempt takes a new one; the requestId keeps Foundry from filing twice.
  const items = [{ key: `partner-${crypto.randomUUID()}`, action: "submit", input: request }];
  const data = await appCall(context, foundry.installationId, requestChangesDocument, { input: { items } });
  const [item] = receipt.parse(data.requestChanges).items;
  const recorded = submitted.safeParse(item?.result);
  if (!recorded.success) throw new Response(item?.error?.message ?? "Software Foundry did not file the request", { status: 422 });
  const { id, kind, issue, run } = recorded.data as z.output<typeof submitted> & { run?: unknown };
  return decide(context, row, { status: "accepted", foundryRequest: JSON.stringify({ requestId: id, kind, issue, run: run ?? null }) });
}

/** RejectPartnerRequest: an editor closes a request without filing it; the partner reads the reason. */
export async function rejectPartnerRequest(context: Context, input: z.output<typeof rejectPartnerRequestInput>) {
  requireEditor(context.identity);
  return decide(context, await proposed(context, input), { status: "rejected", reason: input.reason });
}

/** Editors read the requests, newest first. */
export async function listPartnerRequests(context: Context, status?: PartnerRequest["status"]) {
  requireEditor(context.identity);
  const rows = await context.db().select().from(partnerRequests)
    .where(and(eq(partnerRequests.installationId, context.identity.installationId), ...(status ? [eq(partnerRequests.status, status)] : [])))
    .orderBy(desc(partnerRequests.createdAt)).limit(200);
  return rows.map(partnerRequestView);
}

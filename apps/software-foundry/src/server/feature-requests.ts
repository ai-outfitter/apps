// RequestFeature: record a feature request in the owner's Wiki as a FeatureRequest, attributed
// to the verified caller, its organization and the Governance role it filed under. It opens no
// GitHub issue and starts no work. See docs/foundry-intake.md.
import { z } from "zod";
import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { schemaJSON } from "@ai-outfitter/app-sdk/agent-schema";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { appActor, isResidentPrincipal, requireEditor, sha256Hex } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { nodeInput, wikiGraph } from "@ai-outfitter/onto/contracts";
import { readWikiGraph, stableGraphId, wikiAdapter } from "@ai-outfitter/onto/client";
import { nodeWitness, startWorkInput } from "./graph-work";
import { approvedTarget, type IntakeContext } from "./intake";

const conflict = (message: string) => new Response(message, { status: 409 });
const prose = z.string().trim().min(1).max(16000);
const featureBrief = z.strictObject({
  title: z.string().trim().min(1).max(160),
  problem: prose,
  requestedChange: prose,
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(50),
});
export const requestFeatureInput = z.strictObject({
  requestId: z.uuid().transform((value) => value.toLowerCase())
    .describe("Caller-generated ID. Reuse it to retry an identical request; changed content conflicts."),
  target: startWorkInput.shape.target,
  ...featureBrief.shape,
  relatedNodes: z.array(nodeWitness).max(20).default([])
    .describe("Existing active nodes in this organization's Wiki, at their current revisions. Links record relevance, not approval."),
});

const blockers = ["Feature intake review and execution handoff are not configured. This request is recorded only; an explicit authorized handoff is required before creating an issue or starting work."];
/** The FeatureRequest body. Its shape is the one Wikis set up by earlier Foundry versions validate. */
const featureRequestDocument = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("awaiting_configuration"),
  requestId: z.uuid(),
  installationId: z.string(),
  organizationId: z.string(),
  organizationSlug: z.string(),
  principalId: z.string(),
  kind: z.enum(["human", "agent"]),
  actor: appActor,
  originActor: appActor,
  target: z.strictObject({
    repository: z.string(),
    repositoryId: z.number().int().positive(),
    project: z.strictObject({ id: z.uuid(), revision: z.number().int().positive() }).nullable(),
  }),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  brief: featureBrief,
  submittedAt: z.iso.datetime(),
  organization: nodeWitness,
  submitter: nodeWitness,
  assignments: z.array(nodeWitness).min(1).max(32),
  relatedNodes: z.array(nodeWitness).max(20),
  blockers: z.array(z.string()).min(1),
});
/** What Governance's governance.submission-authority answers for the caller. */
const authorityResult = z.strictObject({
  organizationId: z.string(),
  organization: nodeWitness,
  principalId: z.string(),
  kind: z.enum(["human", "agent"]),
  submitter: nodeWitness,
  assignments: z.array(nodeWitness).min(1).max(32),
});

/** The FeatureRequest type and its links, set up add-only in the Wiki on first use. */
const typeIds = {
  request: "e9600000-0000-4000-8000-000000000020",
  organization: "e9600000-0000-4000-8000-000000000021",
  submitter: "e9600000-0000-4000-8000-000000000022",
  role: "e9600000-0000-4000-8000-000000000023",
  context: "e9600000-0000-4000-8000-000000000024",
};
export const featureRequestType = typeIds.request;
const edgeType = (id: string, name: string, title: string, body: string, from: string[], to: string[] | "any") =>
  ({ id, category: "edge" as const, name, title, body, properties: [], ontology: { version: 2 as const, endpoints: { from, to } } });
const featureRequestTypes = wikiGraph.parse({
  types: [
    { id: typeIds.request, category: "node", name: "FeatureRequest", title: "Feature request", properties: [], jsonSchema: schemaJSON(featureRequestDocument),
      body: "A feature request filed through Software Foundry's RequestFeature, with authenticated provenance. Recorded only: no intake review or execution handoff is configured. Never a Product or an approval." },
    edgeType(typeIds.organization, "feature_request_organization", "Feature request organization", "The organization resolved from the authenticated Software Foundry installation that owns this request.", [typeIds.request], ["71000000-0000-4000-8000-000000000001"]),
    edgeType(typeIds.submitter, "feature_request_submitter", "Feature request submitter", "The verified Person or Agent that submitted this request. Identity binding, not a supplied name or node ID, establishes attribution.", [typeIds.request], ["71000000-0000-4000-8000-000000000005", "71000000-0000-4000-8000-000000000006"]),
    edgeType(typeIds.role, "feature_request_role", "Submission role", "A qualifying organizational role assignment verified by Governance at submission. This is historical submission evidence, not current authority or RAPID approval.", [typeIds.request], ["71000000-0000-4000-8000-000000000019"]),
    edgeType(typeIds.context, "feature_request_context", "Feature request context", "An explicitly referenced existing node relevant to a request. Inclusion establishes relevance only, not approval, causality or a proven domain claim.", [typeIds.request], "any"),
  ],
  nodes: [], edges: [],
});

type Host = WorkflowHost<"interactive">;
const json = (body: unknown) => { try { return JSON.parse(String(body)); } catch { return null; } };
type Witness = z.output<typeof nodeWitness>;

/** The caller's verified Person or Agent and current role assignments, from the one installed Governance. */
export async function verifiedAuthority(host: Host, context: IntakeContext) {
  // The platform filters this listing by template: a similarly named action in another app is not authority.
  const publishers = (await host.call("actions.list", { template: "governance" })).filter((app) =>
    app.actions.some((action) => action.name === "governance.submission-authority" && action.access === "read" && action.permitted));
  if (publishers.length !== 1) throw conflict("One configured Governance authority provider is required");
  const authority = authorityResult.parse(await host.call("actions.call", {
    installationId: publishers[0].installationId, action: "governance.submission-authority", input: {}, readOnly: true,
  }));
  const { organizationId, userId } = context.identity;
  const principalId = context.originActor.kind === "oauth-client" ? `oauth:${context.originActor.id}:${userId}` : userId;
  const kind = context.originActor.kind === "oauth-client" || isResidentPrincipal(userId) ? "agent" : "human";
  if (authority.organizationId !== organizationId || authority.principalId !== principalId || authority.kind !== kind)
    throw new Response("Verified submission authority does not match the caller", { status: 403 });
  return { authority, principalId, kind } as const;
}

/** Every referenced node is active, current and typed in this Wiki, checked before the first write. */
function verifyReferences(graph: Awaited<ReturnType<typeof readWikiGraph>>, nodes: Witness[]) {
  const active = (row: EntityRecord) => !row.attributes.archived && !row.attributes.archivedAt;
  for (const selected of nodes) {
    if (selected.ref.installationId !== graph.wiki.installationId) throw conflict("References must belong to this organization's Wiki");
    const row = graph.nodes.find((node) => node.ref.id === selected.ref.id);
    if (!row || !active(row) || row.revision !== selected.revision || !graph.types.some((type) => active(type) && type.ref.id === row.attributes.typeId))
      throw conflict("A referenced node is unavailable, archived or stale");
  }
}

export async function requestFeature(context: IntakeContext, input: z.output<typeof requestFeatureInput>) {
  return recordWorkRequest(context,input);
}
function validatedReferences(graph: Awaited<ReturnType<typeof readWikiGraph>>, authority: Awaited<ReturnType<typeof verifiedAuthority>>["authority"], nodes: Witness[]) {
  const relatedNodes = [...nodes].sort((a, b) => canonicalActionValue(a.ref).localeCompare(canonicalActionValue(b.ref)));
  if (new Set(relatedNodes.map((node) => node.ref.id)).size !== relatedNodes.length) throw conflict("Related nodes must be unique");
  verifyReferences(graph, [authority.organization, authority.submitter, ...authority.assignments, ...relatedNodes]);
  return relatedNodes;
}
export function workRequestSchema(requestKind: "feature" | "bug" | undefined) {
  return requestKind ? featureRequestDocument.extend({status:z.enum(["received","awaiting_review"]),blockers:z.array(z.string()),requestKind:z.enum(["feature","bug"])}) : featureRequestDocument;
}
function workRequestTypes(requestKind: "feature" | "bug" | undefined, documentSchema: ReturnType<typeof workRequestSchema>) {
  return requestKind ? wikiGraph.parse({...featureRequestTypes,types:featureRequestTypes.types.map(type => type.id === typeIds.request ? {...type,id:"e9600000-0000-4000-8000-000000000025",name:"WorkRequest",title:"Work request",jsonSchema:schemaJSON(documentSchema),body:"An attributed feature or bug request awaiting intake and review."} : type)}) : featureRequestTypes;
}
export async function recordWorkRequest(context: IntakeContext, input: z.output<typeof requestFeatureInput>, requestKind?: "feature" | "bug") {
  requireEditor(context.identity);
  const { organizationId, installationId } = context.identity;
  if (!organizationId || context.identity.owner.kind !== "organization" || context.originActor.kind === "app")
    throw new Response("An organization installation and verified initiating caller are required", { status: 403 });
  const host = context.host();
  const { organization } = await host.call("organization.context", {});
  if (!organization || organization.id !== organizationId || !organization.slug) throw conflict("Organization context is unavailable");
  const { repo, project } = await approvedTarget(context, input.target, host);
  const target = { repository: repo.name, repositoryId: repo.repositoryId, project: project ? { id: project.id, revision: project.revision } : null };
  const graph = await readWikiGraph(host);
  if (!graph.wiki.writable) throw new Response("Wiki is not writable", { status: 403 });
  const { authority, principalId, kind } = await verifiedAuthority(host, context);
  const relatedNodes = validatedReferences(graph, authority, input.relatedNodes);

  const { requestId, target: _target, relatedNodes: _related, ...brief } = input;
  const fingerprint = await sha256Hex(new TextEncoder().encode(canonicalActionValue({ brief, relatedNodes, target })));
  const documentSchema = workRequestSchema(requestKind);
  const document = documentSchema.parse({
    schemaVersion: 1, status: requestKind ? "received" : "awaiting_configuration", ...(requestKind ? {requestKind} : {}), requestId, installationId, organizationId, organizationSlug: organization.slug,
    principalId, kind, actor: context.actor, originActor: context.originActor, target, fingerprint, brief,
    submittedAt: new Date().toISOString(), organization: authority.organization, submitter: authority.submitter,
    assignments: authority.assignments, relatedNodes, blockers:requestKind ? [] : blockers,
  });
  const types = workRequestTypes(requestKind, documentSchema);
  const recordType = requestKind ? "e9600000-0000-4000-8000-000000000025" : typeIds.request;
  const id = await stableGraphId(requestKind ? `foundry-work-request-${requestKind}-v1` : "foundry-feature-request-v1", installationId, principalId, requestId);
  const attributes = nodeInput.safeParse({ id, typeId: recordType, title: brief.title, body: JSON.stringify(document) });
  if (!attributes.success) throw new Response("The feature request exceeds the Wiki's limits", { status: 413 });

  // Refusals end above; from here the request is written, and a retry with the same requestId resumes it.
  const records = wikiAdapter(host, graph.wiki.installationId);
  await records.setup(types);
  const record = await records.createOrRead("graph-node", { ...attributes.data, id });
  const saved = documentSchema.safeParse(json(record.attributes.body));
  const same = (a: Witness, b: Witness) => a.ref.id === b.ref.id;
  if (!saved.success || record.attributes.typeId !== recordType || saved.data.fingerprint !== fingerprint ||
    !same(saved.data.organization, authority.organization) || !same(saved.data.submitter, authority.submitter) ||
    saved.data.assignments.map((row) => row.ref.id).join() !== authority.assignments.map((row) => row.ref.id).join())
    throw conflict("Request ID already belongs to a different feature request, or the saved request was edited");
  const links: [string, Witness][] = [
    [typeIds.organization, authority.organization], [typeIds.submitter, authority.submitter],
    ...authority.assignments.map((row) => [typeIds.role, row] as [string, Witness]),
    ...relatedNodes.map((row) => [typeIds.context, row] as [string, Witness]),
  ];
  for (const [typeId, node] of links) await records.link(typeId, id, node.ref.id);
  return {
    ref: record.ref, revision: record.revision, repository: target.repository,
    submittedAt: saved.data.submittedAt, created: saved.data.submittedAt === document.submittedAt,
  };
}

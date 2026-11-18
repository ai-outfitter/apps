import { defineAction, publishActionTools } from "@ai-outfitter/app-sdk/actions";
import type { ForerunnerContext } from "./context";
import { z } from "zod";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
import { graphGraphqlResult } from "@ai-outfitter/app-sdk/graph-protocol";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { Database } from "./items";
import { getPreview, type Preview } from "./discovery";

type Host = WorkflowHost<"interactive">;
const needKinds = new Set(["Problem", "Goal", "Project", "UseCase", "Requirement", "Opportunity", "Activity"]);
export const planningCandidatesInput = z.strictObject({ previewId: z.uuid() });
export const planningIntakeInput = planningCandidatesInput.extend({
  entryIndex: z.number().int().min(0), expectedId: z.uuid(), expectedRevision: z.number().int().positive(),
  planningInstallationId: z.string().min(1).max(128), projectId: z.uuid().optional(),
  kind: z.enum(["customer-problem", "use-case", "user-story", "competitor", "competitor-product", "requirement-change"]).default("customer-problem"),
  confirmDestination: z.literal(true),
});

// This is Planning's published CreateIntake document, not arbitrary mutation text.
// Its contract test compares normalized text to the destination's published registry.
export const planningCreateIntakeDocument = `mutation CreateIntake($input: CreateIntakeInput!) {
  createIntake(input: $input) {
    id revision projectId kind title description sourceUrls sources originatingMessage releaseFit releaseFitHistory routing routingError
    routes { id revision kind dependsOn rationale gate { installationId controlId } blocker claim { principal until } draft result observedAt gateReceipt gateError receipt submissionIntent subject }
  }
}`;
async function saved(db: Database, who: AppIdentity, previewId: string) {
  requireEditor(who);
  const preview = await getPreview(db, who, previewId);
  if (!preview?.savedAt || !preview.receipt) throw new Response("Save and review this discovery before creating Planning intake", { status: 409 });
  if (preview.destination !== (who.owner.kind === "user" ? "personal" : "organization"))
    throw new Response("Discovery belongs to a different destination", { status: 403 });
  return preview;
}
function selected(preview: Preview, index: number) {
  const entry = preview.entries[index];
  if (!entry || !needKinds.has(entry.kind)) throw new Response("Select a discovered need, goal, project or use case", { status: 400 });
  // Corrections deliberately retain the original id: matchedId is the current identity.
  const id = entry.matchedId ?? entry.id;
  if (!id) throw new Response("This discovery has no unambiguous saved identity", { status: 409 });
  return { entry, id };
}
async function canonical(host: Host, preview: Preview, id: string, typeId?: string) {
  const record = await host.call("entities.get", { installationId: preview.wikiInstallationId, type: "graph-node", id });
  if (typeId && record.attributes.typeId !== typeId) throw new Response("The discovered record type changed; review the discovery again", { status: 409 });
  if (record.attributes.archived) throw new Response("The discovered record is archived", { status: 409 });
  return record;
}
/** Private preview evidence never leaves Forerunner. Only existing authorized Wiki records qualify. */
export async function planningCandidates(db: Database, who: AppIdentity, host: Host, input: z.output<typeof planningCandidatesInput>) {
  const preview = await saved(db, who, input.previewId);
  const eligible = preview.entries.map((entry, entryIndex) => ({ entry, entryIndex })).filter(({ entry }) => needKinds.has(entry.kind));
  const items = [];
  for (const { entryIndex } of eligible.slice(0, 50)) {
    const { id, entry } = selected(preview, entryIndex);
    try {
      const record = await canonical(host, preview, id, entry.typeId);
      items.push({ entryIndex, expectedId: id, expectedRevision: record.revision, title: record.title, kind: entry.kind });
    } catch (error) {
      if (!(error instanceof Response) || ![403, 404, 409].includes(error.status)) throw error;
      items.push({ entryIndex, blocked: "The canonical record is not available; finish Wiki review or choose a current match" });
    }
  }
  const installations = await host.call("actions.list", { template: "planning" });
  const available = installations.filter(app => app.actions.some(action => action.name === "graph.mutate" && action.permitted));
  const destinations = [];
  for (const app of available.slice(0, 5)) {
    try {
      const result = graphGraphqlResult.parse(await host.call("actions.call", { installationId: app.installationId, action: "graph.graphql", readOnly: true,
        input: { query: "query DiscoveryPlanningProjects { projects(first: 20) { nodes { id name revision } pageInfo { endCursor hasNextPage } } }" } }));
      if (result.errors?.length || result.extensions?.truncated) throw new Error("Project read incomplete");
      const projects = z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), revision: z.number() })), pageInfo: z.object({ endCursor: z.string().nullable(), hasNextPage: z.boolean() }) }).parse(result.data?.projects);
      destinations.push({ installationId: app.installationId, projects });
    } catch { destinations.push({ installationId: app.installationId, unavailable: "Project list unavailable; inspect Planning before choosing a project" }); }
  }
  return { previewId: preview.id, owner: who.owner, items, destinations, destinationsTruncated: available.length > 5, truncated: eligible.length > 50,
    coverage: "Saved discovery need identities and same-owner Planning destinations only; first 20 projects per destination. Private source samples and uncommitted proposals are excluded." };
}
export async function createPlanningIntake(db: Database, who: AppIdentity, host: Host, raw: z.output<typeof planningIntakeInput>) {
  const input = planningIntakeInput.parse(raw);
  const preview = await saved(db, who, input.previewId);
  const { id, entry } = selected(preview, input.entryIndex);
  if (id !== input.expectedId) throw new Response("The discovery match was corrected; read candidates again", { status: 409 });
  const record = await canonical(host, preview, id, entry.typeId);
  if (record.revision !== input.expectedRevision) throw new Response("The discovered need changed; read candidates again", { status: 409 });
  // actions.list/call authorize the explicitly selected owner's installations. Membership
  // is never evidence that a private discovery should be copied to an organization.
  const available = await host.call("actions.list", { template: "planning", installationId: input.planningInstallationId });
  if (!available.some(app => app.installationId === input.planningInstallationId && app.actions.some(action => action.name === "graph.mutate" && action.permitted)))
    throw new Response("Choose an authorized Planning installation in this discovery's owner scope", { status: 403 });
  const requestId = await stableGraphId(who.owner, who.installationId, "discovery-planning-intake", preview.wikiInstallationId,
    id, String(record.revision), input.planningInstallationId, input.projectId ?? "", input.kind);
  const prose = [record.title, record.attributes.summary, record.attributes.body].filter(value => typeof value === "string" && value.trim()).join("\n\n").slice(0, 16000);
  const result = graphGraphqlResult.parse(await host.call("actions.call", {
    installationId: input.planningInstallationId, action: "graph.mutate",
    input: { query: planningCreateIntakeDocument, operationName: "CreateIntake", variables: { input: {
      requestId, kind: input.kind, title: record.title.slice(0, 200), description: prose || record.title,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      sources: [{ ...record.ref, revision: record.revision }],
    } } },
  }));
  const refusal = result.errors?.[0];
  if (refusal) {
    const status = Number(refusal.extensions?.status ?? 502);
    throw new Response(refusal.message, { status: status >= 400 && status <= 599 ? status : 502 });
  }
  if (result.extensions?.truncated || !result.data?.createIntake)
    throw new Response("Planning intake was not confirmed. Retry this same selection; its stable request ID prevents duplicate capture.", { status: 502 });
  return { requestId, planningInstallationId: input.planningInstallationId, source: { ...record.ref, revision: record.revision }, intake: result.data.createIntake };
}


/** The sidebar uses the same domain functions as the published documents, with reviewed proposals. */
export const planningIntakeTools = publishActionTools("forerunner", {
  "discovery.planning-candidates": defineAction({ description: "Read current canonical need candidates from a saved private discovery, honoring corrected matches", access: "read", input: planningCandidatesInput, output: z.json(),
    run: async (c: ForerunnerContext, input) => JSON.parse(JSON.stringify(await planningCandidates(c.db(), c.identity, c.host(), input))) }),
  "discovery.planning-intake": defineAction({ description: "Prepare explicit confirmation to capture one reviewed discovered need in the same owner's Planning installation", access: "write", input: planningIntakeInput, output: z.json(),
    run: async (c: ForerunnerContext, input) => JSON.parse(JSON.stringify(await createPlanningIntake(c.db(), c.identity, c.host(), input))) }),
});

// The organization's Onto, reached through the platform graph client: read the storyboards,
// add the app's types (add-only) and stage records as one change batch for review.
import { graphGraphqlResult, graphMutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import { readWikiGraph, stableGraphId, wikiAdapter } from "@ai-outfitter/app-sdk/graph-client";
import { wikiChangeDocuments } from "@ai-outfitter/app-sdk/graph-contracts";
import { type AppIdentity, requireEditor } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { z } from "zod";
import { stageInput, storyboardProposals, storyboardsFromGraph, videoTypes } from "./onto";

type Host = WorkflowHost<"interactive">;

export async function readStoryboards(host: Host) {
  return storyboardsFromGraph(await readWikiGraph(host));
}

/** Add the app's types to an Onto. A type it already has under the same ID and name is left as it is. */
export const setupVideoTypes = (host: Host, ontoInstallationId: string) => wikiAdapter(host, ontoInstallationId).setup(videoTypes);

type Batch = { id: string; state: string; counts: Record<string, number> };

async function ontoMutate<T>(host: Host, installationId: string, name: "StageChanges" | "SubmitBatch", input: Record<string, unknown>) {
  const result = graphGraphqlResult.parse(await host.call("actions.call", {
    installationId, action: graphMutateAction,
    input: { query: wikiChangeDocuments[name].document, operationName: name, variables: { input } } as never,
  }));
  const error = result.errors?.[0];
  if (error || !result.data) throw new Response(error?.message ?? `${name} returned no data`, { status: Number(error?.extensions?.status ?? 422) });
  return result.data as T;
}

const ontoPath = (onto: { hostname: string | null; slug: string }) => (onto.hostname ? `https://${onto.hostname}/` : `/apps/${onto.slug}/`);

/** Stage a brief, a storyboard, its shots and their references as one Onto change batch and submit it for review. */
export async function stageStoryboard(identity: AppIdentity, host: Host, raw: z.input<typeof stageInput>) {
  requireEditor(identity);
  const input = stageInput.parse(raw);
  const graph = await readWikiGraph(host);
  if (!graph.wiki.writable) throw new Response("Your Onto is not writable", { status: 403 });
  const ontoId = graph.wiki.installationId;
  await setupVideoTypes(host, ontoId);
  const owner = identity.organizationId ?? identity.userId;
  const { proposals, storyboardId } = await storyboardProposals(graph, input, (kind, key) => stableGraphId(`video-production-${kind}-v1`, ontoId, owner, key),
    `${identity.installationId}/storyboards/${input.storyboard.key}`);
  const path = ontoPath(graph.wiki);
  if (!proposals.length) return { batchId: null, state: null, proposals: 0, storyboardId, ontoPath: path };
  const title = `Storyboard: ${input.storyboard.title ?? graph.nodes.find((node) => node.ref.id === storyboardId)?.title ?? input.storyboard.key}`;
  let batch: Batch | undefined;
  for (let i = 0; i < proposals.length; i += 100) {
    const page = proposals.slice(i, i + 100);
    batch = (await ontoMutate<{ stageChanges: Batch }>(host, ontoId, "StageChanges", batch
      ? { batchId: batch.id, proposals: page }
      : { title, purpose: "Plan a video: its brief, storyboard, shots in order and the visual references they need.", proposals: page })).stageChanges;
  }
  const submitted = (await ontoMutate<{ submitBatch: Batch }>(host, ontoId, "SubmitBatch", { batchId: batch!.id, summary: `${proposals.length} changes for one storyboard` })).submitBatch;
  return { batchId: submitted.id, state: submitted.state, proposals: proposals.length, storyboardId, ontoPath: path };
}

import type { APIRoute } from "astro";
import { agentDatabase, installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { refreshKnowledgeGraphQueries } from "../../../server/knowledge-graph-refresh";
import { ensureEnrichmentSchedule } from "../../../server/graph-enrichment";
import { ensureSealTimer } from "../../../server/seal-timer";
import { initializeOwnerRoot } from "../../../server/owner-root";
import { setupStandardData } from "../../../server/standard-data";

export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    const who = requestIdentity(request);
    const result = await setupStandardData(agentDatabase(), who);
    const ownerRoot = await initializeOwnerRoot(installationDatabase(), who);
    // Existing Wikis get their stored documents compiled over the types they have now.
    await refreshKnowledgeGraphQueries(installationDatabase());
    const enrichmentSchedule = await installEnrichment(locals);
    return { ...result, ownerRoot, enrichmentSchedule, sealTimer: await sealTimer(locals) };
  });

/** Review windows close on time through an hourly invocation. A host that cannot
 * schedule one (an older platform, or a test without a host) leaves the Wiki
 * usable: windows then close when someone opens Changes or the Today card. */
async function sealTimer(locals: App.Locals) {
  try {
    return (await ensureSealTimer(workflowHost<"interactive">(locals))) ? "saved" : "kept";
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    console.warn("onto seal timer unavailable", error.status);
    return "unavailable";
  }
}


async function installEnrichment(locals: App.Locals) {
  try {
    return await ensureEnrichmentSchedule(workflowHost<"interactive">(locals));
  } catch (error) {
    if (error instanceof Response && [403, 503].includes(error.status)) return "unavailable";
    throw error;
  }
}

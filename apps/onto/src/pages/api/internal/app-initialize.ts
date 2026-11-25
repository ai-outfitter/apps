import type { APIRoute } from "astro";
import { agentDatabase, installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestActor, requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { reportTimezone } from "@ai-outfitter/app-sdk/daily-period";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { refreshKnowledgeGraphQueries } from "../../../server/knowledge-graph-refresh";
import { ensureSealTimer } from "../../../server/seal-timer";
import { initializeOwnerRoot } from "../../../server/owner-root";
import { dailyWorkflow } from "../../../server/daily-update";
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
    const dailyUpdate = who.owner.kind === "user" || (who.canEdit && requestActor(request, who).kind === "member")
      ? await ensureDailyUpdate(locals) : "needs-editor";
    return { ...result, ownerRoot, sealTimer: await sealTimer(locals), dailyUpdate };
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

async function ensureDailyUpdate(locals: App.Locals) {
  try {
    await workflowHost<"interactive">(locals).call("schedule.save", { workflow: dailyWorkflow, timezone: reportTimezone, ifUnset: true });
    return "ready";
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    console.warn("onto daily update schedule unavailable", error.status);
    return "unavailable";
  }
}

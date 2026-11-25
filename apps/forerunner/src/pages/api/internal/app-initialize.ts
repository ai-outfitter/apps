import type { APIRoute } from "astro";
import { requestActor, requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { discoveryWorkflow } from "../../../server/schedule";
import { dailyBriefWorkflow, saveDefaultBriefSchedule } from "../../../server/daily-brief";

export const POST: APIRoute = ({ request, locals }) => respond(async () => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
    throw new Response("Read-only demo", { status: 403 });
  const who = requestIdentity(request);
  if (who.owner.kind !== "user") return { dailyBrief: "personal-only" };
  if (!who.canEdit || (who.owner.id !== who.userId && requestActor(request, who).kind !== "platform"))
    throw new Response("Owner/editor or trusted setup required", { status: 403 });
  try {
    const host = workflowHost<"interactive">(locals);
    const schedules = await host.call("schedules", {});
    if (schedules.some(row => row.workflowId === dailyBriefWorkflow)) return { dailyBrief: "kept" };
    const timezone = schedules.find(row => row.workflowId === discoveryWorkflow && row.enabled)?.timezone;
    if (!timezone) return { dailyBrief: "needs-timezone" };
    await saveDefaultBriefSchedule(host, timezone);
    return { dailyBrief: "ready" };
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    console.warn("forerunner daily brief schedule unavailable", error.status);
    return { dailyBrief: "unavailable" };
  }
});

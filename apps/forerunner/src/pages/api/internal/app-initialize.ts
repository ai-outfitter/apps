import type { APIRoute } from "astro";
import { reportTimezone } from "@ai-outfitter/app-sdk/daily-period";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { discoveryWorkflow } from "../../../server/schedule";
import { dailyBriefWorkflow } from "../../../server/daily-brief";

export const POST: APIRoute = ({ request, locals }) => respond(async () => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
    throw new Response("Read-only demo", { status: 403 });
  const who = requestIdentity(request);
  if (who.owner.kind !== "user") return { dailyBrief: "personal-only" };
  try {
    const host = workflowHost<"interactive">(locals);
    const schedules = await host.call("schedules", {});
    const timezone = schedules.find(row => row.workflowId === discoveryWorkflow && row.enabled)?.timezone ?? reportTimezone;
    await host.call("schedule.save", {
      workflow: dailyBriefWorkflow, timezone, ifUnset: true,
    });
    return { dailyBrief: "ready" };
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    console.warn("forerunner daily brief schedule unavailable", error.status);
    return { dailyBrief: "unavailable" };
  }
});

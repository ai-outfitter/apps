import { dailyBriefWorkflow, scheduledDailyBrief } from "../../../../server/daily-brief";
import { researchReportWorkflow, scheduledResearchReports } from "../../../../server/research-report";
import { runDiscoveryTask } from "../../../../server/tasks";
import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import { workflowPhaseHandler } from "@ai-outfitter/app-sdk/workflow-host";
import { scheduledDiscovery } from "../../../../server/schedule";

// The reserved workflow host route: only platform dispatch, with trusted props,
// reaches it. The app runs its schedules here: the daily discovery run, the daily brief and research reports.
export const POST: APIRoute = ({ request, locals }) =>
  workflowPhaseHandler({
    interactive: (input, host) => runDiscoveryTask(installationDatabase(), requestIdentity(request), input, host),
    schedule: (input, host) => {
      const workflow = (input.schedule as { workflowId?: string } | undefined)?.workflowId;
      if (workflow === dailyBriefWorkflow) return scheduledDailyBrief(installationDatabase(), requestIdentity(request), input, host);
      if (workflow === researchReportWorkflow) return scheduledResearchReports(requestIdentity(request), input, host);
      return scheduledDiscovery(installationDatabase(), requestIdentity(request), input, host);
    },
  })(request, locals as never);

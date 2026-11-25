import {dailyUpdate,dailyWorkflow} from "../../../../server/daily-update";
import { processScheduledReview, reviewWorkflow } from "../../../../server/batch-review";
import { auditOnSchedule, auditWorkflow } from "../../../../server/ontology-audit";
import { scheduleInput } from "@ai-outfitter/app-sdk/workflow-host";
import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import { workflowHost, workflowPhaseHandler } from "@ai-outfitter/app-sdk/workflow-host";
import { sealOnSchedule } from "../../../../server/seal-timer";

// The reserved workflow host route: only platform dispatch, with trusted props,
// reaches it. Member schedules run Onto tasks; service invocations only seal review windows.
export const POST: APIRoute = ({ request, locals }) =>
  workflowPhaseHandler({
    schedule: async (input) => {
      const { schedule, runId } = scheduleInput.parse(input);
      const identity = requestIdentity(request);
      const host = workflowHost<"schedule">(locals);
      if (!identity.canEdit) return { outcome: "declined", reason: "An editor must own the Onto schedule" };
      if(schedule.workflowId===dailyWorkflow)return dailyUpdate(host,identity,input);
      if (schedule.workflowId === reviewWorkflow) {
        const reviewed = await processScheduledReview(installationDatabase(), identity, host, runId);
        if (!reviewed?.runId) return { outcome: "declined", reason: reviewed?.error ?? "No current Onto review was available" };
        return reviewed.runId === runId ? { outcome: "started" } : { outcome: "resumed", runId: reviewed.runId };
      }
      if (schedule.workflowId === auditWorkflow) {
        return auditOnSchedule(installationDatabase(), identity, host, input);
      }
      return { outcome: "declined", reason: "Unknown Onto workflow" };
    },
    invocation: (input) => sealOnSchedule(installationDatabase(), requestIdentity(request), input),
  })(request, locals as never);

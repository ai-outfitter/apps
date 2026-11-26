import { enrichGraph, enrichmentInput, enrichmentWorkflow } from "../../../../server/graph-enrichment";
import {dailyUpdate,dailyWorkflow} from "../../../../server/daily-update";
import { processScheduledReview, reviewWorkflow } from "../../../../server/batch-review";
import { auditOnSchedule, auditWorkflow } from "../../../../server/ontology-audit";
import { scheduleInput } from "@ai-outfitter/app-sdk/workflow-host";
import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import { workflowHost, workflowPhaseHandler } from "@ai-outfitter/app-sdk/workflow-host";
import { passageOnSchedule, passageWorkflow } from "../../../../server/passage-index";
import { withPassageReviewHost } from "../../../../server/passage-review";
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
      if (schedule.workflowId === enrichmentWorkflow) {
        const input = enrichmentInput.parse({ prompt: schedule.inputs["explore.inputs.prompt"] ?? schedule.inputs.prompt });
        await enrichGraph(installationDatabase(), identity, host, input, runId);
        return { outcome: "started" };
      }
      if(schedule.workflowId===dailyWorkflow)return dailyUpdate(host,identity,input);
      if (schedule.workflowId === passageWorkflow)
        return withPassageReviewHost(() => identity, () => host, () => passageOnSchedule(identity, host, input));
      if (schedule.workflowId === reviewWorkflow) {
        const reviewed = await withPassageReviewHost(() => identity, () => host, () => processScheduledReview(installationDatabase(), identity, host, runId));
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

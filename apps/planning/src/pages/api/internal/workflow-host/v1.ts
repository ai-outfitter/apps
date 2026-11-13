import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import { scheduleInput, type scheduleResult, taskInvocation, workflowPhaseHandler, workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { z } from "zod";
import { planningContext } from "../../../../server/context";
import { runPreparation } from "../../../../server/delivery-prepare";
import { digestWorkflow, runDigestTask, scheduledDigests } from "../../../../server/digests";
import { measurementsWorkflow, recordMeasurements } from "../../../../server/measurements";

import { productReportWorkflow, runProductReport, regenerateProductReport } from "../../../../server/product-report-workflow";

type ScheduleResult = z.infer<typeof scheduleResult>;

// The reserved workflow host route: only platform dispatch, with trusted props, reaches it.
// Planning implements two registered tasks (delivery preparation for a saved project revision,
// and a project's digest) and one schedule, the morning digest of every active project.
export const POST: APIRoute = ({ request, locals }) =>
  workflowPhaseHandler({
    interactive: (input) =>
      taskInvocation.safeParse(input).data?.task === productReportWorkflow
        ? runProductReport(workflowHost<"interactive">(locals as never),requestIdentity(request),input)
        :       taskInvocation.safeParse(input).data?.task === digestWorkflow
        ? runDigestTask(installationDatabase(), workflowHost<"interactive">(locals as never), requestIdentity(request), input)
        : runPreparation(planningContext(request, locals), input),
    schedule: async (input, host): Promise<ScheduleResult> => {
      const occurrence = scheduleInput.parse(input);
      if (occurrence.schedule.workflowId === productReportWorkflow) {
        await host.call("workflow.start",{workflow:productReportWorkflow,id:occurrence.runId,inputs:{}});
        await regenerateProductReport(host,requestIdentity(request),occurrence.runId,new Date(occurrence.scheduledFor));
        return {outcome:"started"};
      }
      if (occurrence.schedule.workflowId === measurementsWorkflow) {
        await recordMeasurements(host, requestIdentity(request), {}, { runId: occurrence.runId, now: occurrence.scheduledFor });
        return { outcome: "started" };
      }
      if (occurrence.schedule.workflowId !== digestWorkflow)
        return { outcome: "declined", reason: `Planning does not schedule ${occurrence.schedule.workflowId}` };
      const saved = (await host.call("schedules", {})).find(row => row.id === occurrence.schedule.id);
      if (!saved) return { outcome: "declined", reason: "Report schedule no longer exists" };
      await scheduledDigests(installationDatabase(), host, requestIdentity(request), occurrence.runId, {now:occurrence.scheduledFor,timezone:saved.timezone});
      return { outcome: "started" };
    },
  })(request, locals as never);

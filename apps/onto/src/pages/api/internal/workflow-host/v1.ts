import { failExpiredReviewJobs, processReviewJob, reviewWorkflow } from "../../../../server/batch-review";
import { ontoReviewJobs } from "../../../../server/schema";
import { and, or, eq, lte, sql } from "drizzle-orm";
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
      const { schedule } = scheduleInput.parse(input);
      const identity = requestIdentity(request);
      const host = workflowHost<"schedule">(locals);
      if (!identity.canEdit) return { outcome: "declined", reason: "An editor must own the Onto schedule" };
      if (schedule.workflowId === reviewWorkflow) {
        const now = Date.now();
        await failExpiredReviewJobs(installationDatabase(), now);
        const [job] = await installationDatabase().select().from(ontoReviewJobs).where(and(sql`${ontoReviewJobs.attempts} < 4`, or(and(eq(ontoReviewJobs.state, "pending"), lte(ontoReviewJobs.nextAttemptAt, now)), and(eq(ontoReviewJobs.state, "running"), lte(ontoReviewJobs.leaseUntil, now))))).limit(1);
        if (!job) return { outcome: "declined", reason: "No pending Onto reviews" };
        const reviewed = await processReviewJob(installationDatabase(), identity, host, job.id, scheduleInput.parse(input).runId);
        return reviewed?.runId ? { outcome: "started" } : { outcome: "declined", reason: "Review work was already claimed or superseded" };
      }
      if (schedule.workflowId === auditWorkflow) {
        return auditOnSchedule(installationDatabase(), identity, host, input);
      }
      return { outcome: "declined", reason: "Unknown Onto workflow" };
    },
    invocation: (input) => sealOnSchedule(installationDatabase(), requestIdentity(request), input),
  })(request, locals as never);

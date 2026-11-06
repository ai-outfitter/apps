import { z } from "zod";
export const foundryLandingWorkflow = "foundry-land-reviewed-change";
const stateSchema = z.object({
  ready: z.literal(true), summary: z.string().min(1), passed: z.literal(true),
  candidate: z.object({ number: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/), branch: z.string(), url: z.string() }),
  review: z.object({ verdict: z.literal("approved"), headSha: z.string(), id: z.number().int().positive(), reviewer: z.object({ id: z.number().int().positive() }) }),
  checks: z.array(z.object({ passed: z.literal(true), headSha: z.string() })).min(1),
});
type Prior = { run: { id: string; status: string; workflowId: string }; state: { inputs: Record<string, unknown>; rows: Record<string, { complete: boolean; value: unknown }> } };
const interruptedReviews = [
  "The environment stopped unexpectedly during this run. Review its output before trying again in a new workspace.",
  "The environment restarted during this run. Review its output before trying again.",
];
function reviewedState(prior: Prior, finalReviewFailure?: string) {
  if (prior.run.workflowId === foundryLandingWorkflow) return prior.state.inputs["land.inputs.previous"];
  const reviewed = prior.state.rows["review-final.outputs.result"];
  // A completed review always takes precedence, including requested changes.
  if (reviewed?.complete) return reviewed.value;
  if (!interruptedReviews.includes(finalReviewFailure ?? "")) return;
  const validated = prior.state.rows["validate-final.outputs.result"];
  return validated?.complete ? validated.value : undefined;
}
/** Inputs are loaded from the authenticated prior run, never accepted from a resume body. */
export function landingContinuation(prior: Prior, finalReviewFailure?: string) {
  if (prior.run.status !== "failed") return;
  const recovering = prior.run.workflowId === foundryLandingWorkflow;
  if (!recovering && prior.run.workflowId !== "issue-to-merge-actions-ci") return;
  const previous = reviewedState(prior, finalReviewFailure);
  const parsed = stateSchema.safeParse(previous);
  if (!parsed.success) return;
  const sourceRunId = recovering ? prior.state.inputs["land.inputs.sourceRunId"] : prior.run.id;
  if (!z.string().uuid().safeParse(sourceRunId).success) return;
  const event = (prior.state.inputs[recovering ? "land.inputs.event" : "triage.inputs.event"]) as { issue?: { number?: number }; sourceRunId?: string } | undefined;
  const branchIdentity = z.uuid().safeParse(event?.sourceRunId ?? sourceRunId);
  if (!branchIdentity.success) return;
  const branchRunId = branchIdentity.data;
  const state = parsed.data;
  if (state.candidate.branch !== `outfitter/issue-${event?.issue?.number}-${branchRunId}` ||
      state.review.headSha !== state.candidate.headSha ||
      state.checks.some(check => check.headSha !== state.candidate.headSha)) return;
  return { previous, sourceRunId, branchRunId, previousRunId: prior.run.id };
}

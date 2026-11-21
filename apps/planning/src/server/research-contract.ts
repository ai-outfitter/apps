import { z } from "zod";

/** A guided investigation, not a new executor or permission to spend a budget. */
export const researchBrief = z.strictObject({
  question: z.string().trim().min(1).max(2000),
  decision: z.string().trim().min(1).max(2000),
  owner: z.string().trim().min(1).max(200),
  scope: z.array(z.string().trim().min(1).max(2000)).min(1).max(32),
  exclusions: z.array(z.string().trim().min(1).max(2000)).max(32),
  stoppingCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(32),
  timeboxMinutes: z.number().int().positive().max(10080),
  successMeasure: z.string().trim().min(1).max(2000),
});

/** Evidence lives in the existing result.sources; artifacts remain in their producing app. */
export const researchConclusion = z.strictObject({
  outcome: z.enum(["supported", "rejected", "inconclusive", "blocked"]),
  conclusion: z.string().trim().min(1).max(8000),
  stopReason: z.string().trim().min(1).max(2000),
  elapsedMinutes: z.number().nonnegative(),
  artifacts: z.array(z.strictObject({
    title: z.string().trim().min(1).max(200),
    url: z.url({ protocol: /^https?$/ }),
  })).max(32),
});

export function validateResearchResult(
  brief: z.infer<typeof researchBrief> | undefined,
  result: { research?: z.infer<typeof researchConclusion>; sources: unknown[]; gaps: string[] },
) {
  if (!brief) return; // Existing intakes remain valid.
  if (!result.research) throw new Response("Research requires a conclusion and explicit stop reason", { status: 422 });
  const outcome = result.research.outcome;
  if ((outcome === "supported" || outcome === "rejected") && !result.sources.length)
    throw new Response("A supported or rejected conclusion requires evidence", { status: 422 });
  if ((outcome === "inconclusive" || outcome === "blocked") && !result.gaps.some(gap => gap.trim()))
    throw new Response("An inconclusive or blocked result must explain the remaining gap", { status: 422 });
}

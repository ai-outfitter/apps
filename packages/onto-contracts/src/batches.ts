import { z } from "zod";
import { evidenceList } from "@ai-outfitter/connector-core/evidence";
import { graphChangeInput } from "./changes";
export const batchOperationCap = 2000;
export const batchExpiryMs = 7 * 24 * 3600 * 1000;
/** Lowest confidence a policy may accept without a member. */
export const policyThresholdFloor = 0.9;

const ref = z.string().regex(/^\$[a-z][a-z0-9_-]{0,63}$/i);
const operation = graphChangeInput.shape.operations.element;
const timezone = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Unknown time zone");
const reviewWindow = z.union([
  z.strictObject({ until: z.literal("end-of-day"), timezone }),
  z.strictObject({ hours: z.number().int().min(1).max(168) }),
]);
export const batchPolicy = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("member") }),
  z.strictObject({
    kind: z.literal("confidence"),
    threshold: z.number().min(policyThresholdFloor).max(1),
    version: z.string().min(1).max(64),
    /** When set, operations still waiting at the deadline commit by policy. */
    reviewWindow: reviewWindow.optional(),
  }),
  /** The first discovery run of a Wiki commits everything on submit. */
  z.strictObject({ kind: z.literal("first-run"), version: z.string().min(1).max(64) }),
]);
export type BatchPolicy = z.infer<typeof batchPolicy>;
export const batchSource = z.strictObject({
  kind: z.enum(["discovery-run", "work-package", "import", "agent-task", "meeting"]),
  ref: z.string().min(1).max(256),
  label: z.string().max(200).optional(),
});

export const batchOpenInput = z.strictObject({
  title: z.string().min(1).max(200),
  purpose: z.string().max(2000).default(""),
  source: batchSource.optional(),
  policy: batchPolicy.default({ kind: "member" }),
});
const proposal = z.strictObject({
  operation,
  evidence: evidenceList.default([]),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().max(1000).optional(),
});
export const batchAddInput = z.strictObject({
  batchId: z.uuid(),
  proposals: z.array(proposal).min(1).max(100),
});
export const batchRemoveInput = z.strictObject({ batchId: z.uuid(), refs: z.array(ref).min(1).max(100) });
export const batchIdInput = z.strictObject({ batchId: z.uuid() });
export const batchListInput = z.strictObject({
  state: z.enum(["open", "awaiting_review", "committed", "rejected", "discarded"]).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const batchSubmitInput = z.strictObject({
  batchId: z.uuid(),
  summary: z.string().max(2000).optional(),
});
export const batchReviewInput = z.strictObject({
  batchId: z.uuid(),
  /** Omit refs to decide every operation still waiting. */
  refs: z.array(ref).min(1).max(batchOperationCap).optional(),
  verdict: z.enum(["approve", "reject"]),
  comment: z.string().max(2000).optional(),
});
export const recordHistoryInput = z.strictObject({ id: z.uuid() });

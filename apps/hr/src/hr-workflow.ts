import { z } from "zod";
import {
  hiring,
  hiringDefinitions,
  type HiringState,
} from "../hiring";

export const staffingInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    need: z.string().trim().min(20).max(8000),
    approverEmail: z.string().trim().pipe(z.email().max(320)),
  })
  .strict();
export const hiringAction = z.discriminatedUnion("action", [
  z
    .object({
      action: z.enum(["approve", "request_changes", "reject", "cancel"]),
      revision: z.number().int().min(1),
      note: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal("resubmit"),
      revision: z.number().int().min(1),
      title: staffingInput.shape.title,
      need: staffingInput.shape.need,
    })
    .strict(),
]);
export type HiringAction = z.infer<typeof hiringAction>;
export type RequestAuthority = {
  requesterId: string;
  approverId: string;
  state: HiringState;
  revision: number;
};

export function transitionHiring(
  row: RequestAuthority,
  actorId: string,
  action: HiringAction,
  packageVersion: string = hiring.version,
): HiringState {
  if (row.revision !== action.revision)
    throw new Response("Request changed; reload before deciding", {
      status: 409,
    });
  const definition = hiringDefinitions[packageVersion];
  // Cancellation ends a request even if its old executor was removed.
  if (
    !definition &&
    action.action === "cancel" &&
    actorId === row.requesterId &&
    !["cancelled", "rejected"].includes(row.state)
  )
    return "cancelled";
  if (!definition)
    throw new Response("Pinned workflow definition unavailable", {
      status: 409,
    });
  const actor =
    actorId === row.requesterId
      ? "requester"
      : actorId === row.approverId
        ? "approver"
        : null;
  const transition = definition.transitions.find(
    (step) =>
      step.from === row.state &&
      step.action === action.action &&
      step.by === actor,
  );
  if (transition) return transition.to;
  throw new Response("This action is not permitted for this request", {
    status: 403,
  });
}

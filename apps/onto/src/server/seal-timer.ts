import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { invocationInput, type PhaseInput, type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { type Database, sealDueBatches } from "./graph-batches";

// Review windows close on time. Each Wiki keeps one installation-owned
// invocation; the platform tick dispatches it every hour as the invocation's
// service principal, and the Wiki seals its own due batches by their stored
// policy. The principal can do nothing else: it approves no member decision.

export const sealInvocation = "batches.seal";
export const sealIntervalMinutes = 60;

/** Saves the hourly seal once; later activations keep its schedule. */
export async function ensureSealTimer(host: WorkflowHost<"interactive">) {
  const existing = await host.call("invocations", {});
  if (existing.some((invocation) => invocation.name === sealInvocation)) return false;
  await host.call("invocation.save", { name: sealInvocation, owner: "installation", intervalMinutes: sealIntervalMinutes, enabled: true });
  return true;
}

/** The `invocation` phase: seal what is due, as the Wiki's own policy. */
export async function sealOnSchedule(db: Database, who: AppIdentity, input: PhaseInput): Promise<PhaseInput> {
  const { invocation, scheduledFor } = invocationInput.parse(input);
  if (invocation.name !== sealInvocation) return { outcome: "declined", reason: `This app does not run ${invocation.name}` };
  // Policy approval is recorded as policy, never as this principal's decision.
  const sealer: AppIdentity = { ...who, entityWriter: "wiki-map/review-window" };
  const { sealed, expired } = await sealDueBatches(db, sealer, Math.max(scheduledFor, Date.now()));
  return { outcome: "completed", summary: `sealed ${sealed}, expired ${expired}` };
}

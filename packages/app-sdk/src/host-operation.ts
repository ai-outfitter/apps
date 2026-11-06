import type { z } from "zod";

/** Shared definition of one workflow-host operation: the phases that may call
 * it and its input and output schemas. Per-domain operation maps (threads,
 * platform records) use it so the workflow host can compose them. */
export const hostPhases = ["event", "operator", "interactive", "schedule", "prepare", "publish", "finalize", "invocation"] as const;
export type HostPhase = (typeof hostPhases)[number];
export type HostOperation = { phases: readonly HostPhase[]; input: z.ZodType; output: z.ZodType };
export const hostOperation = <const P extends readonly HostPhase[], I extends z.ZodType, O extends z.ZodType>(
  phases: P, input: I, output: O,
) => ({ phases, input, output }) satisfies HostOperation;
/** Phases that run an app's own work for a member or schedule. */
export const runningPhases = ["event", "operator", "interactive", "schedule"] as const;

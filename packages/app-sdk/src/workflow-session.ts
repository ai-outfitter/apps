import { z } from "zod";

/** Portable execution evidence, not a chat transcript or authority to resume production. */
export const sessionEntry = z.strictObject({
  id: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/),
  parentId: z.string().max(128).nullable(),
  kind: z.enum(["checkpoint", "inference-start", "inference-result", "result"]),
  step: z.string().max(128),
  at: z.iso.datetime(),
  data: z.json(),
});
export type SessionEntry = z.infer<typeof sessionEntry>;
export const workflowSession = z.object({
  format: z.literal("outfitter-workflow-session-v1"),
  exportedAt: z.iso.datetime(),
  run: z.object({
    id: z.string(), workflowId: z.string(), createdBy: z.string(),
    installationId: z.string().nullable(), organizationId: z.string().nullable(),
    trigger: z.enum(["manual", "schedule", "unknown"]), status: z.string(),
    createdAt: z.number(), updatedAt: z.number(),
    definition: z.json(), definitionHash: z.string(),
    packageHash: z.string().nullable(),
  }),
  inputs: z.json(), outputs: z.json(), attempts: z.array(z.json()),
  entries: z.array(sessionEntry), gaps: z.array(z.string()),
  branch: z.object({ sessionId: z.string(), checkpointId: z.string(), implementation: z.string(), overrides: z.json() }).optional(),
});
export type WorkflowSession = z.infer<typeof workflowSession>;
export type ReplayOverrides = {
  instructions?: string; model?: string; maxOutputTokens?: number;
  timeoutMs?: number; batchBudget?: number;
};
export interface WorkflowReplayAdapter {
  id: string;
  replay(session: WorkflowSession, checkpointId: string, overrides: ReplayOverrides): Promise<{ session: WorkflowSession; output: unknown }>;
}

export function sessionDownload(session: WorkflowSession) {
  return new Response(JSON.stringify(workflowSession.parse(session), null, 2), { headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="workflow-session-${encodeURIComponent(session.run.id)}.json"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
}

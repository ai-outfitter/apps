import type { WorkflowRun } from "@ai-outfitter/app-sdk/workflows";

/** Render historical nodes from the pinned definition, even after package upgrades. */
export function runNodes(run: WorkflowRun) {
  return run.workflow.steps.map((step) => ({
    ...step,
    status: run.steps[step.id] ?? "waiting",
    attempts: (run.attempts ?? []).filter((attempt) => attempt.nodeId === step.id).sort((a, b) => a.createdAt - b.createdAt),
    actorKind: step.actor ? run.workflow.actors[step.actor]?.kind : undefined,
    evidence: Object.fromEntries(
      Object.entries(run.rows).filter(([slot]) =>
        slot.startsWith(`${step.id}.outputs.`),
      ),
    ),
  }));
}

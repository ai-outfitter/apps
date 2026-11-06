import type { WorkflowRun } from "@ai-outfitter/app-sdk/workflows";
/** Domain presentation belongs to the app; engine status remains unchanged. */
export function foundryRunStatus(
  run: Pick<WorkflowRun, "workflow" | "rows" | "status">,
) {
  if (
    ["issue-to-merge-actions-ci", "issue-to-merge-workspace"].includes(
      run.workflow?.id,
    ) &&
    (run.rows?.["triage.outputs.result"]?.value as { ready?: boolean })
      ?.ready === false
  )
    return "needs-details";
  return run.status;
}

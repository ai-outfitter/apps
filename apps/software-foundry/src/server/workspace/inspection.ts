import type { OperationOutput, WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { foundryLandingWorkflow } from "./landing-recovery";
import {
  foundryWorkspaceWorkflow,
  issueRuns,
  issueToMergeWorkflows,
  resolveFoundryRepository,
} from "./workspaces";

type Operator = WorkflowHost<"operator">;
type Snapshot = OperationOutput<"snapshot">;
const actors = ["triager", "engineer", "validator", "reviewer", "repairer", "lander"];

/** Read-only. Inspect current receipts without dispatching or rewriting outputs. */
export async function inspectFoundryWorkspace(host: Operator, repository: string, reviewerLogin: string, number?: number) {
  const snapshot = await host.call("snapshot", {});
  const resolved = await resolveFoundryRepository(host, snapshot, repository);
  if (!resolved)
    throw new Response("Enabled current repository workflow required", { status: 409 });
  const { subscription, repo } = resolved;
  const reviewerBinding = subscription.inputs["triage.inputs.reviewerBinding"];
  const configurationValid = validConfiguration(snapshot, subscription);
  const [reviewer, active, pending] = await Promise.all([
    configurationValid && typeof reviewerBinding === "string"
      ? host.call("workspace.control", { bindingId: reviewerBinding, operation: "inspect-reviewer", reviewer: reviewerLogin })
      : null,
    host.call("workflow.active", {
      slots: ["triage.inputs.event", "land.inputs.event"],
      workflows: [...issueToMergeWorkflows, foundryLandingWorkflow],
    }),
    host.call("workflow.pending", {}),
  ]);
  const url = `https://${snapshot.installation.hostname}/workflows?workflow=${foundryWorkspaceWorkflow}`;
  return {
    repository: repo.name,
    repositoryId: Number(subscription.resource),
    installationId: snapshot.installation.id,
    subscriptionId: subscription.id,
    workflow: foundryWorkspaceWorkflow,
    configurationValid,
    url,
    reviewer,
    activeRunIds: active
      .filter((run) => Object.values(run.inputs).some((event) =>
        String((event as { repository?: { id?: unknown } } | null)?.repository?.id) === subscription.resource))
      .map((run) => run.id),
    pendingDeliveryIds: pending.filter((item) => item.subscriptionId === subscription.id).map((item) => item.id),
    run: number ? await inspectedRun(host, subscription.resource, number, url) : null,
  };
}

/** The subscription is enabled on a connection this installation can use, and
 * every role binding is approved for the active package. */
function validConfiguration(snapshot: Snapshot, subscription: Snapshot["subscriptions"][number]) {
  const activeHash = snapshot.installation.activeHash;
  return subscription.enabled && snapshot.connections.some((connection) => connection.id === subscription.connectionId) &&
    actors.every((actor) => snapshot.bindings.some((binding) =>
      binding.actor === actor &&
      binding.id === subscription.inputs[`triage.inputs.${actor}Binding`] &&
      binding.enabled &&
      binding.packageHash === activeHash));
}

/** The issue's newest run with its outputs, node attempts and connector intake. */
async function inspectedRun(host: Operator, resource: string, number: number, url: string) {
  const [latest] = await issueRuns(host, resource, number);
  if (!latest) return null;
  const [loaded, intake] = await Promise.all([
    host.call("workflow.read", { id: latest.id }),
    host.call("connector.receipts", { runId: latest.id }),
  ]);
  if (!loaded) return null;
  return {
    id: latest.id,
    url: `${url}&run=${latest.id}`,
    workflow: loaded.run.workflowId,
    rows: loaded.outputs,
    steps: loaded.readiness.steps,
    attempts: loaded.attempts,
    intake,
    status:
      loaded.run.status === "failed"
        ? "failed"
        : (loaded.outputs["triage.outputs.result"]?.value as { ready?: boolean } | null)?.ready === false
          ? "needs-details"
          : loaded.readiness.run,
  };
}

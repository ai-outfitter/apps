import {
  eventInput,
  type eventResult,
  finalizeInput,
  type PhaseInput,
  prepareInput,
  type WorkflowHost,
  workflowPhaseHandler,
} from "@ai-outfitter/app-sdk/workflow-host";
import type { StorageLocals } from "@ai-outfitter/app-sdk/storage";
import { z } from "zod";
import { finalizeWorkspaceNode, prepareWorkspaceNode } from "./workspace/execution";
import { inspectFoundryWorkspace } from "./workspace/inspection";
import { publishFoundryEvidence } from "./workspace/publication";
import {
  configureFoundryWorkspaces,
  issueToMergeWorkflows,
  launchFoundryMergeChecks,
  launchFoundryWorkspaceIssue,
  startExistingFoundryIssue,
} from "./workspace/workspaces";
import { repositoryName } from "./projects";

/** Gateway operator requests: inspect, configure or start a repository's Foundry workflow. */
const operatorInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("inspect"), repository: repositoryName, reviewer: z.string().min(1).max(128).default("vega"), number: z.number().int().positive().optional() }),
  z.object({ operation: z.literal("configure"), repository: repositoryName, reviewer: z.string().min(1).max(128).default("vega"), model: z.string().max(128).optional(),
    ci: z.enum(["actions", "workspace"]).optional() }),
  z.object({
    operation: z.literal("start"), repository: repositoryName, number: z.number().int().positive(),
    resume: z.object({ runId: z.uuid(), requestId: z.uuid() }).strict().optional(),
  }),
]);

/** A delivery starts the reserved run, or is declined with the reason recorded. */
async function event(host: WorkflowHost<"event">, raw: unknown): Promise<z.input<typeof eventResult>> {
  const delivery = eventInput.parse(raw);
  const { subscription, trigger, runId } = delivery;
  const { type, resource, payload } = delivery.event;
  if (!issueToMergeWorkflows.includes(subscription.workflowId)) {
    // Foundry's other event workflows start with the event at their trigger input.
    await host.call("workflow.start", { workflow: subscription.workflowId, id: runId, inputs: { ...subscription.inputs, [trigger.input]: payload } });
    return { outcome: "started" };
  }
  if (type === "github.merge-group") {
    await launchFoundryMergeChecks(host, resource, payload, runId);
    return { outcome: "started" };
  }
  const launched = await launchFoundryWorkspaceIssue(host, { resource, inputs: subscription.inputs }, payload, runId);
  return launched.existing
    ? { outcome: "declined", reason: `The issue already has running Foundry run ${launched.id}` }
    : { outcome: "started" };
}

async function operator(host: WorkflowHost<"operator">, raw: unknown): Promise<PhaseInput> {
  const input = operatorInput.parse(raw);
  const result = input.operation === "inspect"
    ? await inspectFoundryWorkspace(host, input.repository, input.reviewer, input.number)
    : input.operation === "configure"
      ? await configureFoundryWorkspaces(host, input.repository, input.reviewer, input.model, input.ci)
      : await startExistingFoundryIssue(host, input.repository, input.number, input.resume);
  return JSON.parse(JSON.stringify(result));
}

/** Software Foundry's workflow policy, served at the reserved workflow host path. */
export function foundryPhases(locals: StorageLocals, origin: string) {
  const files = { locals, origin };
  return workflowPhaseHandler({
    event: (input, host) => event(host, input),
    operator: (input, host) => operator(host, input),
    prepare: async (input, host) => prepareWorkspaceNode(host, prepareInput.parse(input)),
    publish: async (input, host) => publishFoundryEvidence(host, locals, origin, input),
    finalize: async (input, host) => finalizeWorkspaceNode(host, files, finalizeInput.parse(input)) as Promise<PhaseInput>,
  });
}

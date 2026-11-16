// What graph.graphql and graph.mutate run with: the caller's identity and actors (actionAPI)
// and a host that reaches the organization's Onto through the platform.
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { type WorkflowHost, workflowHost } from "@ai-outfitter/app-sdk/workflow-host";

export type VideoContext = ActionContext & { host: () => WorkflowHost<"interactive"> };

export const videoServices = (locals: unknown): Omit<VideoContext, keyof ActionContext> => ({
  host: () => workflowHost<"interactive">(locals as never),
});

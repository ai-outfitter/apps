/** Turning Foundry execution on for a repository, from Foundry itself. */
import { z } from "zod";
import { requireEditor } from "@ai-outfitter/app-sdk/server";
import type { IntakeContext } from "./intake";
import { repositoryName } from "./projects";
import { configureFoundryWorkspaces } from "./workspace/workspaces";

export const enableRepositoryInput = z.strictObject({
  repository: repositoryName.describe("owner/name, reachable through this organization's GitHub connection."),
  reviewer: z.string().min(1).max(128).default("vega").describe("The workspace's independent reviewer."),
});

/** The platform checks that the caller is an organization owner or admin and that
 * the connection covers the repository; identical current bindings are reused. */
export async function enableRepository(context: IntakeContext, input: z.output<typeof enableRepositoryInput>) {
  requireEditor(context.identity);
  const { repository, subscriptionId, workflow } = await configureFoundryWorkspaces(context.host(), input.repository, input.reviewer);
  return { repository, subscriptionId, workflow };
}

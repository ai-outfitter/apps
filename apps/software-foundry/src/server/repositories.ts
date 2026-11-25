/** Turning Foundry execution on for a repository, from Foundry itself. */
import { z } from "zod";
import { requireEditor } from "@ai-outfitter/app-sdk/server";
import { defineAction } from "@ai-outfitter/app-sdk/actions";
import type { IntakeContext } from "./intake";
import { repositoryName } from "./projects";
import { configureFoundryWorkspaces, type ScheduledFoundryJob, foundryJobs, runFoundryJob, scheduleFoundryJob, templateAuditJob } from "./workspace/workspaces";

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

const scheduledJobs = Object.keys(foundryJobs) as ScheduledFoundryJob[];
export const jobInput = z.strictObject({
  job: z.enum([...scheduledJobs, templateAuditJob]).describe("dependency-review, architecture-reanalysis, ui-review or community-template-audit."),
  repository: repositoryName.describe("owner/name, reachable through this organization's GitHub connection."),
});
export const scheduleJobInput = jobInput.extend({
  job: z.enum(scheduledJobs).describe("dependency-review, architecture-reanalysis or ui-review."),
  enabled: z.boolean().default(true).describe("false pauses the job's schedule."),
});

/** Start a repository job now: its workspace agent is approved when the job requires one. */
export async function runJob(context: IntakeContext, input: z.output<typeof jobInput>) {
  requireEditor(context.identity);
  return runFoundryJob(context.host(), input.job, input.repository);
}

/** The same job runner exposed as a reviewed sidebar proposal. The host still
 * checks current membership, repository access and binding authority on apply. */
export const runJobAction = defineAction({
  description: "Run a repository job: community-template-audit reads contributor template coverage without changing the repository; ui-review reviews one app's pages at phone and desktop sizes and files screenshot-backed fixes; dependency-review and architecture-reanalysis file maintenance issues. Jobs that file issues require Foundry to be enabled on the repository. Filed issues can start work that opens and merges pull requests. Owners and admins only.",
  access: "write",
  canInvoke: (context: IntakeContext) => context.identity.canEdit &&
    context.identity.owner.kind === "organization" &&
    context.identity.role.split(",").some((role) => role === "owner" || role === "admin"),
  input: jobInput,
  output: z.object({ job: jobInput.shape.job, repository: z.string(), run: z.string() }),
  run: runJob,
});

/** Save, or pause, the job's one schedule on its declared cadence. */
export async function scheduleJob(context: IntakeContext, input: z.output<typeof scheduleJobInput>) {
  requireEditor(context.identity);
  return scheduleFoundryJob(context.host(), input.job, input.repository, input.enabled);
}

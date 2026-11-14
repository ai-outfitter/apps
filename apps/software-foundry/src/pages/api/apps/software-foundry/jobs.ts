import type { APIRoute } from "astro";
import { readJSON, requestIdentity, requireEditor, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { jobInput, scheduleJobInput } from "../../../../server/repositories";
import { foundryJobs, runFoundryJob, scheduleFoundryJob } from "../../../../server/workspace/workspaces";

const change = z.discriminatedUnion("action", [
  jobInput.extend({ action: z.literal("run") }),
  scheduleJobInput.extend({ action: z.literal("schedule") }),
]);

/** The Jobs page's schedules: this installation's, for its repository jobs. */
export const GET: APIRoute = ({ locals }) =>
  respond(async () => {
    const schedules = await workflowHost<"interactive">(locals).call("schedules", {});
    return Response.json({ items: schedules.filter((item) => Object.hasOwn(foundryJobs, item.workflowId)) });
  });

/** An editor runs a job now or saves (or pauses) its schedule. */
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    requireEditor(requestIdentity(request));
    const input = await readJSON(request, change, 4096);
    const host = workflowHost<"interactive">(locals);
    return Response.json(
      input.action === "run"
        ? await runFoundryJob(host, input.job, input.repository)
        : await scheduleFoundryJob(host, input.job, input.repository, input.enabled),
      { status: 202 },
    );
  });

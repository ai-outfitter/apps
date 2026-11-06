import type { APIRoute } from "astro";
import { readJSON, requestIdentity, requireEditor, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { startExistingFoundryIssue } from "../../../../server/workspace/workspaces";
import { repositoryName } from "../../../../server/projects";

const startIssue = z.strictObject({
  repository: repositoryName,
  number: z.number().int().positive(),
  resume: z.strictObject({ runId: z.uuid(), requestId: z.uuid() }).optional(),
});

/** An editor starts the canonical workspace workflow on an existing open issue. */
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    requireEditor(requestIdentity(request));
    const input = await readJSON(request, startIssue, 4096);
    return Response.json(
      await startExistingFoundryIssue(workflowHost<"interactive">(locals), input.repository, input.number, input.resume),
      { status: 202 },
    );
  });

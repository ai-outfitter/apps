import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { readJSON, requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { APIRoute } from "astro";
import {
  createProjectContext,
  projectChoices,
  projectRequest,
} from "../../../../server/projects";
export const GET: APIRoute = ({ locals }) =>
  respond(() => projectChoices(workflowHost<"interactive">(locals)));
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () =>
    createProjectContext(
      installationDatabase(),
      requestIdentity(request),
      workflowHost<"interactive">(locals),
      await readJSON(request, projectRequest, 100_000),
    ),
  );

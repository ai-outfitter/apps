import type { APIRoute } from "astro";
import {
  requestIdentity,
  respond,
  readJSON,
} from "@ai-outfitter/app-sdk/server";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import {
  projectContext,
  previewWork,
  previewInput,
} from "../../../../server/work-packages";
import { z } from "zod";
function queryProject(request: Request) {
  const value = z
    .uuid()
    .safeParse(new URL(request.url).searchParams.get("projectId"));
  if (!value.success)
    throw new Response("Select a valid projectId", { status: 400 });
  return value.data;
}
function operational() {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
    throw new Response("Read-only demo", { status: 403 });
}
export const GET: APIRoute = ({ request, locals }) =>
  respond(() => {
    operational();
    return projectContext(
      installationDatabase(),
      requestIdentity(request),
      workflowHost<"interactive">(locals),
      { projectId: queryProject(request) },
    );
  });
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    operational();
    return previewWork(
      installationDatabase(),
      requestIdentity(request),
      workflowHost<"interactive">(locals),
      await readJSON(request, previewInput, 20000),
    );
  });

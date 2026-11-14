import type { APIRoute } from "astro";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { planningWiki } from "../../../../../server/wiki-context";
export const POST: APIRoute = ({ request, locals }) =>
  respond(() => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    return planningWiki(
      requestIdentity(request),
      workflowHost<"interactive">(locals),
    );
  });

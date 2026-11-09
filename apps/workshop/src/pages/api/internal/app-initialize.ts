import type { APIRoute } from "astro";
import {
  requireEditor,
  requestIdentity,
  respond,
} from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { defaultWiki } from "@ai-outfitter/onto/client";
import { setupHardware } from "../../../server/hardware-ontology";
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    requireEditor(requestIdentity(request));
    const host = workflowHost<"interactive">(locals);
    const wiki = await defaultWiki(host);
    await setupHardware(host, wiki.installationId);
    return wiki;
  });

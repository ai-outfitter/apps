import type { APIRoute } from "astro";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { discoveryKind, listDiscovery } from "../../../../../server/discovery";
export const GET: APIRoute = ({ request, params, locals }) =>
  respond(() => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    requestIdentity(request);
    const kind = discoveryKind.safeParse(params.kind);
    if (!kind.success) throw new Response("Not found", { status: 404 });
    return listDiscovery(workflowHost<"interactive">(locals), kind.data);
  });

import { readJSON, requireEditor, respond } from "@ai-outfitter/app-sdk/server";
import type { APIRoute } from "astro";
import { discoveryConnectInput } from "@ai-outfitter/app-sdk/workflow-host";
import { discoverPersonalContent } from "../../../../../server/content-discovery";
import { forerunnerContext } from "../../../../../server/context";


/** The platform calls this after the member connects an explicitly authorized source. */
export const POST: APIRoute = ({ request, locals }) => respond(async () => {
  const context = forerunnerContext(request, locals);
  const who = context.identity;
  requireEditor(who);
  if (who.owner.kind !== "user" || who.owner.id !== who.userId)
    throw new Response("Discovery requires your personal installation", { status: 403 });
  const { grantId } = await readJSON(request, discoveryConnectInput, 12288);
  const result = await discoverPersonalContent(context.db(), who, context.host(), { grantId, now: Date.now() });
  return { status: result.status };
});

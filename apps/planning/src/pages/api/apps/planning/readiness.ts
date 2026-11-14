import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { APIRoute } from "astro";
import { assessProjectReadiness } from "../../../../project-readiness";
import { listPlanning } from "../../../../server/planning";
import { readProjectSubgraph } from "../../../../server/wiki-subgraph";

/** Every project's readiness from the part of the Wiki its rules read (one bounded query, not the whole graph). */
export const GET: APIRoute = ({ request, locals }) => respond(async () => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") throw new Response("Read-only demo", { status: 403 });
  const who = requestIdentity(request);
  const planning = await listPlanning(installationDatabase(), who);
  const graph = await readProjectSubgraph(workflowHost<"interactive">(locals), who.installationId, planning.projects.map((p) => p.id), { products: true });
  return { projects: planning.projects.map(p => assessProjectReadiness(graph, who.installationId, p.id)) };
});

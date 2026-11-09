import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { APIRoute } from "astro";
import { z } from "zod";
import { productGraph } from "../../../../lib/graph";
import { projectProductsSelection, readProjectSelection } from "../../../../server/wiki-subgraph";

export const GET: APIRoute = ({ request, locals }) => respond(async () => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") throw new Response("Read-only demo", { status: 403 });
  const identity = requestIdentity(request);
  const host = workflowHost<"interactive">(locals);
  // A project page needs only the revisions its project produces: read that subgraph, not the whole Wiki.
  const projectId = new URL(request.url).searchParams.get("projectId");
  const records = projectId
    ? await readProjectSelection(host, identity.installationId, z.uuid().parse(projectId), projectProductsSelection)
      .catch((error) => { if (error instanceof Response && [400, 404].includes(error.status)) return readWikiGraph(host); throw error; })
    : await readWikiGraph(host);
  return { wiki: records.wiki, graph: productGraph(records) };
});

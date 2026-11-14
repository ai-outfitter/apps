import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { planningContext } from "../../../../server/context";
import { documents, pageWrite } from "../../../../server/documents";

// The project page's "Link merged PRs in the Wiki": the LinkProjectChanges document agents
// run with graph_mutate (the document validates the input; editors only).
const link = pageWrite(documents.LinkProjectChanges.document);

export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    return link(await readJSON(request, z.record(z.string(), z.unknown()), 4096), planningContext(request, locals));
  });

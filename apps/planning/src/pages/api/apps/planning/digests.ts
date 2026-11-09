import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { planningContext } from "../../../../server/context";
import { documents, pageWrite, runDocument } from "../../../../server/documents";

// The Daily digest page's writes run the documents agents run with graph_mutate (the
// document validates the input): POST writes a project's digest now, PUT turns the
// morning digest on or off.
const writes = { POST: pageWrite(documents.GenerateProjectDigest.document), PUT: pageWrite(documents.ChangeDigestSchedule.document) };

const route: APIRoute = ({ request, locals }) =>
  respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    // GET: the latest digest runs, as the platform records them.
    if (request.method === "GET") return Object.values(await runDocument(documents.DigestRuns.document, {}, planningContext(request, locals)))[0];
    const write = writes[request.method as keyof typeof writes];
    if (!write) throw new Response("Method not allowed", { status: 405 });
    return write(await readJSON(request, z.record(z.string(), z.unknown()), 4096), planningContext(request, locals));
  });
export const GET = route;
export const POST = route;
export const PUT = route;

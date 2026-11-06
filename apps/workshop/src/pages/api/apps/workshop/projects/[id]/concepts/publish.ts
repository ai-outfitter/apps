import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { workshopContext } from "../../../../../../../server/context";
import { documents, runDocument } from "../../../../../../../server/documents";

const body = z.object({ productRevisionId: z.string(), revision: z.number().int().nonnegative() }).strict();

/** The page publishes through the same PublishWorkshopConcepts document agents run; the
 * Wiki is written as the member whose request this is. */
export const POST: APIRoute = ({ params, request, locals }) =>
  respond(async () => {
    const input = { projectId: params.id ?? "", ...(await readJSON(request, body, 1024)) };
    return (await runDocument(documents.PublishWorkshopConcepts.document, { input }, workshopContext(request, locals))).publishWorkshopConcepts;
  });

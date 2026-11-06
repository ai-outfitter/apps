import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { workshopContext } from "../../../../../../../server/context";
import { documents, runDocument } from "../../../../../../../server/documents";
import { getWorkshopProject } from "../../../../../../../server/projects";

/** The page removes a concept through the same RemoveWorkshopConcept document agents run,
 * and reads back the whole project it then shows. */
export const DELETE: APIRoute = ({ params, request, locals }) =>
  respond(async () => {
    const { revision } = await readJSON(request, z.object({ revision: z.number().int().nonnegative() }).strict(), 1024);
    const context = workshopContext(request, locals);
    const input = { projectId: params.id ?? "", conceptId: params.conceptId ?? "", revision };
    const { removeWorkshopConcept: row } = await runDocument(documents.RemoveWorkshopConcept.document, { input }, context);
    return getWorkshopProject(context.db(), row.id);
  });

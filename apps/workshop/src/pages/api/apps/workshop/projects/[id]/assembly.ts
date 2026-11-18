import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { assemblyUpdateBody } from "../../../../../../server/projects";
import { workshopContext } from "../../../../../../server/context";
import { documents, runDocument } from "../../../../../../server/documents";

export const PUT: APIRoute = ({ params, request, locals }) =>
  respond(async () => {
    const variables = { projectId: params.id ?? "", ...await readJSON(request, assemblyUpdateBody, 2_000_000) };
    const result = await runDocument(documents.UpdateWorkshopAssembly.document, variables, workshopContext(request, locals));
    return result.updateWorkshopAssembly;
  });

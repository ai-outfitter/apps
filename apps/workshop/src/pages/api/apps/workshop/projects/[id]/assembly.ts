import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { AssemblySchema } from "../../../../../../lib/assembly";
import { workshopContext } from "../../../../../../server/context";
import { documents, runDocument } from "../../../../../../server/documents";

const body = z.strictObject({ expectedRevision: z.int32().nonnegative(), assembly: AssemblySchema });

export const PUT: APIRoute = ({ params, request, locals }) =>
  respond(async () => {
    const variables = { projectId: params.id ?? "", ...await readJSON(request, body, 2_000_000) };
    const result = await runDocument(documents.UpdateWorkshopAssembly.document, variables, workshopContext(request, locals));
    return result.updateWorkshopAssembly;
  });

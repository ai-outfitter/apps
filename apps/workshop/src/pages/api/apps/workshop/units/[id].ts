import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { workshopContext } from "../../../../../server/context";
import { documents, runDocument } from "../../../../../server/documents";
import { UnitInput } from "../../../../../server/units";

const update = z.object({ revision: z.number().int().positive(), unit: UnitInput }).strict();
const remove = z.object({ revision: z.number().int().positive() }).strict();

/** The page changes and removes units through the same documents agents run. */
export const PUT: APIRoute = ({ params, request, locals }) =>
  respond(async () => {
    const input = { id: params.id ?? "", ...(await readJSON(request, update, 8_000)) };
    return (await runDocument(documents.UpdateWorkshopUnit.document, { input }, workshopContext(request, locals))).updateWorkshopUnit;
  });

export const DELETE: APIRoute = ({ params, request, locals }) =>
  respond(async () => {
    const input = { id: params.id ?? "", ...(await readJSON(request, remove, 1024)) };
    return { id: (await runDocument(documents.DeleteWorkshopUnit.document, { input }, workshopContext(request, locals))).deleteWorkshopUnit };
  });

import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { workshopContext } from "../../../../server/context";
import { documents, runDocument } from "../../../../server/documents";
import { UnitInput, listWorkshopUnits } from "../../../../server/units";

export const GET: APIRoute = () => respond(() => listWorkshopUnits(installationDatabase()));

/** The page records a unit through the same RecordWorkshopUnit document agents run. */
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    const input = await readJSON(request, UnitInput, 8_000);
    const { recordWorkshopUnit: unit } = await runDocument(documents.RecordWorkshopUnit.document, { input }, workshopContext(request, locals));
    return Response.json(unit, { status: 201 });
  });

import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { generateConcept, generateInput } from "../../../../../../../server/concepts";
import { workshopContext } from "../../../../../../../server/context";

/** A concept image from the platform's image model, kept in the project like an upload. */
export const POST: APIRoute = ({ params, request, locals }) =>
  respond(async () =>
    Response.json(await generateConcept(workshopContext(request, locals), params.id ?? "", await readJSON(request, generateInput, 8192)), { status: 201 }),
  );

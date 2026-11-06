import type { APIRoute } from "astro";
import { respond } from "@ai-outfitter/app-sdk/server";
import { addConcept } from "../../../../../../server/concepts";
import { workshopContext } from "../../../../../../server/context";

/** An image upload is far larger than a document's variables, so it is stored directly. */
export const POST: APIRoute = ({ params, request, locals }) =>
  respond(async () => Response.json(await addConcept(workshopContext(request, locals), request, params.id ?? ""), { status: 201 }));

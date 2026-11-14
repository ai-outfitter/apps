import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { workshopContext } from "../../../../server/context";
import { designTurn } from "../../../../server/design";
import { designInput } from "../../../../model/design-answer";

/** One design turn: the page's design form sends the first request and each follow-up. */
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    const { project, rationale } = await designTurn(workshopContext(request, locals), await readJSON(request, designInput, 4096));
    return { project, rationale };
  });

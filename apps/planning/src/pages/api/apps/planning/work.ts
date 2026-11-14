import type { APIRoute } from "astro";
import { actionAPI } from "@ai-outfitter/app-sdk/actions";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { planningContext, planningServices } from "../../../../server/context";
import { documents, pageWrite } from "../../../../server/documents";
import { intakePageReads } from "../../../../server/intake";
import { planningExecutionActions } from "../../../../server/work-execution";
import { workPreviewAction } from "../../../../server/work-packages";

/** The intake page's writes run the documents agents run with graph_mutate (the document
 * validates the input); its reads and the work execution page call this route's own actions. */
const pageWrites = new Map([["intake.create", pageWrite(documents.CreateIntake.document)], ["intake.route", pageWrite(documents.RouteIntake.document)]]);

export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    const call = await readJSON(request.clone(), z.object({ action: z.string(), input: z.unknown() }), 256 * 1024);
    const write = pageWrites.get(call.action);
    if (write) return write(call.input, planningContext(request, locals));
    return actionAPI(
      request,
      "call",
      { ...workPreviewAction, ...planningExecutionActions, ...intakePageReads },
      () => planningServices(request, locals),
    );
  });

import type { APIRoute } from "astro";
import { respond } from "@ai-outfitter/app-sdk/server";
import { planningContext } from "../../../../../server/context";
import { readVisualEvidence } from "../../../../../server/visual-evidence";
export const GET: APIRoute = ({ request, locals }) =>
  respond(async () => {
    const url = new URL(request.url);
    return readVisualEvidence(planningContext(request, locals), {
      projectId: url.searchParams.get("projectId"),
      ...(url.searchParams.get("bundleId")
        ? { bundleId: url.searchParams.get("bundleId") }
        : {}),
      ...(url.searchParams.get("batchId")
        ? { batchId: url.searchParams.get("batchId") }
        : {}),
      limit: 1,
    });
  });

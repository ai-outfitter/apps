import type { APIRoute } from "astro";
import { respond } from "@ai-outfitter/app-sdk/server";
import { planningContext } from "../../../../server/context";
import { documents, runDocument } from "../../../../server/documents";
export const GET: APIRoute = ({ request, locals }) =>
  respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    const url = new URL(request.url);
    return runDocument(
      documents.VideoProductions.document,
      {
        ...(url.searchParams.has("id")
          ? { id: url.searchParams.get("id")! }
          : {}),
        ...(url.searchParams.has("revision")
          ? { revision: Number(url.searchParams.get("revision")) }
          : {}),
      },
      planningContext(request, locals),
    );
  });

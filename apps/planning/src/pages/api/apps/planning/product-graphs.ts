import type { APIRoute } from "astro";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import {
  productGraphsInput,
  readProductGraphs,
} from "../../../../server/product-graphs";
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    const identity = requestIdentity(request);
    const parsed = productGraphsInput.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success)
      throw new Response("Invalid product graph selector", { status: 400 });
    return readProductGraphs(
      {
        identity,
        db: () => installationDatabase(),
        host: () => workflowHost<"interactive">(locals),
      },
      parsed.data,
    );
  });

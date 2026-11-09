import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import {
  readJSON,
  requestIdentity,
  respond,
} from "@ai-outfitter/app-sdk/server";
import {
  graphTransfer,
  restoreGraph,
} from "../../../../../server/graph-transfer";

export const POST: APIRoute = ({ request }) =>
  respond(async () =>
    restoreGraph(
      installationDatabase(),
      requestIdentity(request),
      await readJSON(request, graphTransfer, 4_000_000),
      { preview: true },
    ),
  );

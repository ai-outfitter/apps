import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { entityAPI } from "@ai-outfitter/app-sdk/entities";
import type { APIRoute } from "astro";
import { graphEntities } from "../../../../../server/graph-entities";

export const ALL: APIRoute = ({ request, params }) =>
  entityAPI(
    request,
    params.operation ?? "",
    graphEntities(installationDatabase(), { verifiedReferences: true }),
  );

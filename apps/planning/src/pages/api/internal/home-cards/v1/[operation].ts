import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { homeCardAPI } from "@ai-outfitter/app-sdk/home-cards";
import type { APIRoute } from "astro";
import { homeCards } from "../../../../../server/home-cards";

// Reserved: only platform dispatch reaches this route, with the viewer's identity.
export const ALL: APIRoute = ({ request, params }) =>
  homeCardAPI(request, params.operation ?? "", homeCards(installationDatabase));

import type { APIRoute } from "astro";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { orderProjects } from "../../../../../server/projects";

export const PUT: APIRoute = ({ request }) =>
  respond(() =>
    orderProjects(installationDatabase(), requestIdentity(request), request),
  );

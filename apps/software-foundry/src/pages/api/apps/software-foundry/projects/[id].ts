import type { APIRoute } from "astro";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { deleteProject, updateProject } from "../../../../../server/projects";

export const PUT: APIRoute = ({ request, params }) =>
  respond(() =>
    updateProject(
      installationDatabase(),
      requestIdentity(request),
      params.id ?? "",
      request,
    ),
  );

export const DELETE: APIRoute = ({ request, params }) =>
  respond(() =>
    deleteProject(
      installationDatabase(),
      requestIdentity(request),
      params.id ?? "",
      request,
    ),
  );

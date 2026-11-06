import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { readJSON, requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { foundryContext } from "../../../../../server/context";
import { documents, runDocument } from "../../../../../server/documents";
import { createProjectInput, listProjects, readProject } from "../../../../../server/projects";

export const GET: APIRoute = ({ request }) =>
  respond(() => listProjects(installationDatabase(), requestIdentity(request)));

/** The projects page adds a project through the same CreateProject document agents run with
 * graph_mutate, and gets the project back as GET serves it. */
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    const context = foundryContext(request, locals);
    const input = await readJSON(request, createProjectInput, 8192);
    const { createProject } = await runDocument(documents.CreateProject.document, { input }, context);
    return Response.json(await readProject(context.db(), createProject.id), { status: 201 });
  });

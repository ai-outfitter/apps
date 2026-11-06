import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { workshopContext } from "../../../../server/context";
import { documents, runDocument } from "../../../../server/documents";
import { createInput, createWorkshopProject, getWorkshopProject, listWorkshopProjects } from "../../../../server/projects";

export const GET: APIRoute = () =>
  respond(() => listWorkshopProjects(installationDatabase()));

/** The page starts a project from a starter example through the same CreateWorkshopProject
 * document agents run with graph_mutate. A whole project (the platform's design agent saves
 * the model it generated this way) is larger than a document's variables may be, so it is
 * stored directly. Either way the new project comes back whole. */
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    const context = workshopContext(request, locals);
    const input = await readJSON(request, createInput, 2_000_000);
    const project = "example" in input
      ? await getWorkshopProject(context.db(), (await runDocument(documents.CreateWorkshopProject.document, { input }, context)).createWorkshopProject.id)
      : await createWorkshopProject(context.db(), context.identity, input.project);
    return Response.json(project, { status: 201 });
  });

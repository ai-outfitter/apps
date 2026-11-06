import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { readJSON, requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { ProjectSchema } from "../../../../../lib/project";
import { workshopContext } from "../../../../../server/context";
import { documents, runDocument } from "../../../../../server/documents";
import { getWorkshopProject, updateWorkshopProject } from "../../../../../server/projects";

export const GET: APIRoute = ({ params }) =>
  respond(() => getWorkshopProject(installationDatabase(), params.id ?? ""));

/** Saves the whole project document, which may be far larger than a document's variables. */
export const PUT: APIRoute = ({ params, request }) =>
  respond(async () =>
    updateWorkshopProject(installationDatabase(), requestIdentity(request), await readJSON(request, ProjectSchema, 2_000_000), params.id ?? ""),
  );

/** The page deletes a project through the same DeleteWorkshopProject document agents run. */
export const DELETE: APIRoute = ({ params, request, locals }) =>
  respond(async () => {
    const { revision } = await readJSON(request, z.object({ revision: z.number().int().nonnegative() }).strict(), 1024);
    const { deleteWorkshopProject: id } = await runDocument(documents.DeleteWorkshopProject.document, { input: { id: params.id ?? "", revision } }, workshopContext(request, locals));
    return { id };
  });

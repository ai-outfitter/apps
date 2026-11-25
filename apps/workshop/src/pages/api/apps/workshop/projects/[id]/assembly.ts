import { z } from "zod";
import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { assemblySelection } from "../../../../../../server/assembly-selection";
import { resolvedProject } from "../../../../../../server/assembly-references";
import { readWorkshopPrint } from "../../../../../../server/print-analysis";
import { assemblyUpdateBody } from "../../../../../../server/projects";
import { workshopContext } from "../../../../../../server/context";
import { documents, runDocument } from "../../../../../../server/documents";

export const PUT: APIRoute = ({ params, request, locals }) =>
  respond(async () => {
    const variables = { projectId: params.id ?? "", ...await readJSON(request, assemblyUpdateBody, 2_000_000) };
    const result = await runDocument(documents.UpdateWorkshopAssembly.document, variables, workshopContext(request, locals));
    return result.updateWorkshopAssembly;
  });

export const GET: APIRoute = ({params, request, locals}) => respond(async () => {
  const query=new URL(request.url).searchParams;
  const ref = assemblySelection(params.id ?? "", query);
  const context = workshopContext(request, locals);
  const resolved = await resolvedProject(context.db(), ref);
  if (query.get("view") === "print") {
    const selected = z.uuid().optional().safeParse(query.get("itemId")??undefined);
    if (!selected.success) throw new Response("Invalid print selection",{status:400});
    return {revision:resolved.revision,...await readWorkshopPrint(context,resolved.projectId,resolved,selected.data)};
  }
  return resolved;
});

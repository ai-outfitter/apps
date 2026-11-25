import { z } from "zod";
import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { AssemblyReferenceSchema } from "../../../../../../lib/assembly";
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
  let parameters;
  try { if(query.has("parameters")) parameters=JSON.parse(query.get("parameters")!); }
  catch { throw new Response("Invalid configuration parameters",{status:400}); }
  const ref=AssemblyReferenceSchema.safeParse({projectId:params.id,parameters,configuration:query.get("configuration")??undefined,
    revision:query.has("revision")?Number(query.get("revision")):undefined});
  if(!ref.success) throw new Response("Invalid assembly selection",{status:400});
  const context = workshopContext(request, locals);
  const resolved = await resolvedProject(context.db(), ref.data);
  if (query.get("view") === "print") {
    const selected = z.uuid().optional().safeParse(query.get("itemId")??undefined);
    if (!selected.success) throw new Response("Invalid print selection",{status:400});
    return {revision:resolved.revision,...await readWorkshopPrint(context,resolved.projectId,resolved,selected.data)};
  }
  return resolved;
});

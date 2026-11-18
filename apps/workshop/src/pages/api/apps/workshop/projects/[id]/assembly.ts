import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { AssemblyReferenceSchema } from "../../../../../../lib/assembly";
import { resolvedProject } from "../../../../../../server/assembly-references";
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
  return resolvedProject(workshopContext(request,locals).db(),ref.data);
});

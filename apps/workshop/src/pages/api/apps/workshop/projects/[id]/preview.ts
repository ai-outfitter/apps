import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { workshopContext } from "../../../../../../server/context";
import { getWorkshopProject } from "../../../../../../server/projects";
import { previewInput, previewKey, savePreview } from "../../../../../../server/previews";

export const PUT: APIRoute = ({request,locals,params}) => respond(async () => savePreview(workshopContext(request,locals),params.id??"",await readJSON(request,previewInput,12_100_000)));
export const GET: APIRoute = ({request,locals,params}) => respond(async () => {
  const c=workshopContext(request,locals), p=await getWorkshopProject(c.db(),params.id??"");
  const url=new URL(request.url), revision=Number(url.searchParams.get("revision")??p.revision);
  if (!Number.isSafeInteger(revision)||revision<0||revision>p.revision) throw new Response("Invalid revision",{status:400});
  const file=await c.storage().get({space:"builds",key:previewKey(p.id,revision)});
  if(!file) throw new Response("Preview pending capture",{status:404,headers:{"Cache-Control":"no-store"}});
  const evidence=await new Response(file.body).json() as {artifacts:{kind:string;key:string;contentHash:string}[]};
  if(url.searchParams.has("evidence")) return Response.json(evidence);
  const image=evidence.artifacts.find(a=>a.kind==="preview");
  if(!image) throw new Response("Preview unavailable",{status:404});
  const png=await c.storage().get({space:"builds",key:image.key});
  if(!png) throw new Response("Preview unavailable",{status:404});
  return new Response(png.body,{headers:{"Content-Type":"image/png"}});
});

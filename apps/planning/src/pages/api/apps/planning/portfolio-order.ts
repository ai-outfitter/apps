import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { planningContext } from "../../../../server/context";
import { documents, pageWrite, runDocument } from "../../../../server/documents";
const route:APIRoute=({request,locals})=>respond(async()=>{
  if(import.meta.env.OUTFITTER_APP_MODE!=="operational")throw new Response("Read-only demo",{status:403});
  const context=planningContext(request,locals);
  if(request.method==="GET")return (await runDocument(documents.PersonalPortfolio.document,{kind:z.enum(["organizations","projects"]).parse(new URL(request.url).searchParams.get("kind"))},context)).personalPortfolio;
  if(request.method==="POST")return pageWrite(documents.ReorderPersonalPortfolio.document)(await readJSON(request,z.record(z.string(),z.unknown()),65536),context);
  throw new Response("Method not allowed",{status:405});
});
export const GET=route;
export const POST=route;

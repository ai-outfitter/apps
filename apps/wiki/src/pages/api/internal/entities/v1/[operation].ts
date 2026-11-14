import type {APIRoute} from "astro";
import {agentDatabase} from "@ai-outfitter/app-sdk/cloudflare/database";
import {entityAPI} from "@ai-outfitter/app-sdk/entities";
import {documentEntities} from "../../../../../documents/entities";
export const ALL:APIRoute=({request,params})=>{
 if(import.meta.env.OUTFITTER_APP_MODE!=="operational")return new Response("Read-only demo",{status:403});
 return entityAPI(request,params.operation??"",documentEntities(agentDatabase()));
};

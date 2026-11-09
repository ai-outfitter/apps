import type {APIRoute} from "astro";
import {agentDatabase} from "@ai-outfitter/app-sdk/cloudflare/database";
import {dataTransferRoutes} from "@ai-outfitter/app-sdk/data-transfer";
import app from "../../../../../app.json";
const transfer=dataTransferRoutes(agentDatabase,{app:app.id});
/** Exports retain every archive/history table. Generic imports cannot mint revision or approval history. */
export const ALL:APIRoute=(context)=>context.request.method==="GET"&&context.params.operation==="export"?transfer(context):new Response("Use the document API to import content; historical restores require the trusted migration path",{status:405});

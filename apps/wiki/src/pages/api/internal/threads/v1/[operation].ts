import type {APIRoute} from "astro";
import {agentRoute} from "../../../../../documents/agent";
export const POST:APIRoute=({request,params,locals})=>import.meta.env.OUTFITTER_APP_MODE!=="operational"&&params.operation==="types"?Response.json([]):agentRoute(request,params.operation ?? "",locals,true);

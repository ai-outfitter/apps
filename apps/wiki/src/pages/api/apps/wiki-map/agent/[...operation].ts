import type {APIRoute} from "astro";
import {agentRoute} from "../../../../../documents/agent";
export const ALL:APIRoute=({request,params,locals})=>agentRoute(request,params.operation ?? "",locals);

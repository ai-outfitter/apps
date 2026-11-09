import type {APIRoute} from "astro";
import {agentRoute} from "../../../../documents/agent";
export const ALL:APIRoute=({request,locals})=>agentRoute(request,"",locals);

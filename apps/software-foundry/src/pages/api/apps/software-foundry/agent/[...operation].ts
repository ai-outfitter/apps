import type { APIRoute } from "astro";
import { agentRoute } from "../../../../../server/agent-route";
export const ALL: APIRoute = ({ request, params, locals }) => agentRoute(request, params.operation ?? "", locals, false);

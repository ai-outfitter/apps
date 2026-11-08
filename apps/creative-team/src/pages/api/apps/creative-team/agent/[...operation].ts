import type { APIRoute } from "astro";
import { agentRoute } from "../../../../../server/agent-route";

// The sidebar's browser routes: page context, proposals and their review.
export const ALL: APIRoute = ({ request, params, locals }) => agentRoute(request, params.operation ?? "", locals);

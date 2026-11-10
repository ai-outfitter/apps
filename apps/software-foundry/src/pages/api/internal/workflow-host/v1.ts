import type { APIRoute } from "astro";
import { foundryPhases } from "../../../../server/workflow-host";

/** The reserved workflow host route: only platform dispatch, with trusted props, reaches it. */
export const POST: APIRoute = ({ request, locals }) =>
  foundryPhases(locals as never, new URL(request.url).origin)(request, locals as never);

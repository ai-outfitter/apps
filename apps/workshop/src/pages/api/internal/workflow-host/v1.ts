import type { APIRoute } from "astro";
import { workspacePhases } from "../../../../server/workspace-host";
export const POST:APIRoute=({request,locals})=>workspacePhases()(request,locals as never);

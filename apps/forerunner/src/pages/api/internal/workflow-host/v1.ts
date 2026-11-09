import { runDiscoveryTask } from "../../../../server/tasks";
import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import { workflowPhaseHandler } from "@ai-outfitter/app-sdk/workflow-host";
import { scheduledDiscovery } from "../../../../server/schedule";

// The reserved workflow host route: only platform dispatch, with trusted props,
// reaches it. The app implements one phase, its daily discovery run.
export const POST: APIRoute = ({ request, locals }) =>
  workflowPhaseHandler({
    interactive: (input, host) => runDiscoveryTask(installationDatabase(), requestIdentity(request), input, host),
    schedule: (input, host) => scheduledDiscovery(installationDatabase(), requestIdentity(request), input, host),
  })(request, locals as never);

import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import { workflowPhaseHandler } from "@ai-outfitter/app-sdk/workflow-host";
import { sealOnSchedule } from "../../../../server/seal-timer";

// The reserved workflow host route: only platform dispatch, with trusted props,
// reaches it. The Wiki implements one phase, its hourly review-window seal.
export const POST: APIRoute = ({ request, locals }) =>
  workflowPhaseHandler({
    invocation: (input) => sealOnSchedule(installationDatabase(), requestIdentity(request), input),
  })(request, locals as never);

import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { readStoryboards } from "./graph";
import { type Storyboards, storyboardsFromGraph } from "./onto";

const empty: Storyboards = { briefs: [], unbriefed: [] };

/**
 * What a page renders. The demo reads the synthetic fixture; the operational app reads the
 * organization's Onto through the platform. A request with no forwarded member (the
 * platform's deploy check) gets the empty shell.
 */
export async function pageState(request: Request, locals: unknown): Promise<{ model: Storyboards; demo: boolean; signedOut?: boolean }> {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") {
    const { demoGraph } = await import("../../fixtures/demo");
    return { model: storyboardsFromGraph(demoGraph), demo: true };
  }
  try {
    requestIdentity(request);
  } catch (cause) {
    if (cause instanceof Response && cause.status === 401) return { model: empty, demo: false, signedOut: true };
    throw cause;
  }
  return { model: await readStoryboards(workflowHost<"interactive">(locals as never)), demo: false };
}

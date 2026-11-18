import { defaultWiki } from "@ai-outfitter/app-sdk/graph-client";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
/** Shared reads use the authorized graph action, never another app's database. */
export async function creativeQuery(
  host: WorkflowHost<"interactive">,
  query: string,
  variables: Record<string, unknown> = {},
) {
  const wiki = await defaultWiki(host);
  return host.call("actions.call", {
    installationId: wiki.installationId,
    action: "graph.graphql",
    input: JSON.parse(JSON.stringify({ query, variables })),
    readOnly: true,
  });
}

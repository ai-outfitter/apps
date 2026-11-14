import { defaultWiki } from "@ai-outfitter/app-sdk/graph-client";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { setupCodeChanges } from "./code-changes";
import { setupIntakeOntology } from "./intake-ontology";
import { setupMeasurements } from "./measurements";
import { setupUseCases } from "./use-cases";
export async function planningWiki(
  who: AppIdentity,
  host: WorkflowHost<"interactive">,
) {
  const wiki = await defaultWiki(host);
  if (who.canEdit) {
    await setupUseCases(who, host, wiki.installationId);
    await setupIntakeOntology(host, wiki.installationId);
    await setupCodeChanges(host, wiki.installationId);
    await setupMeasurements(host, wiki.installationId);
  }
  return wiki;
}

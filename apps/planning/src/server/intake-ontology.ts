import compiledGraph from "../../graph/.compiled/intake.json";
import { wikiAdapter } from "@ai-outfitter/app-sdk/graph-client";
import { wikiGraph, assertionBody } from "@ai-outfitter/app-sdk/graph-contracts";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
export { intakeType, findingType } from "../../graph/intake";
export const intakeGraph = wikiGraph.parse(compiledGraph);
// Setup remains add-only and runs with installation setup authority.
export async function setupIntakeOntology(host: WorkflowHost<"interactive">, installationId: string) {
  return wikiAdapter(host, installationId).setup(intakeGraph);
}
export { assertionBody };

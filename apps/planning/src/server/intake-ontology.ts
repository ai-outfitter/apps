import { wikiAdapter } from "@ai-outfitter/app-sdk/graph-client";
import { wikiGraph, assertionBody } from "@ai-outfitter/app-sdk/graph-contracts";
import { schemaJSON } from "@ai-outfitter/app-sdk/agent-schema";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
export const intakeType = "e9500000-0000-4000-8000-000000000010";
export const findingType = "e9500000-0000-4000-8000-000000000011";
export const intakeGraph = wikiGraph.parse({ types: [
  { id: intakeType, category: "node", name: "DiscoveryIntake", title: "Discovery intake", body: "A customer or competitive observation accepted for planning. Its source reference identifies the owning Planning intake; it is not proof of a customer claim.", properties: [] },
  { id: findingType, category: "node", name: "ResearchFinding", title: "Research findings", body: "Agent-reported research about a discovery intake, with evidence and uncertainty. Saving a finding is not member confirmation or Governance approval.", properties: [], ontology: { version: 2, stereotype: "assertion" }, jsonSchema: schemaJSON(assertionBody) },
], nodes: [], edges: [] });
// Setup remains add-only and runs with installation setup authority.
export async function setupIntakeOntology(host: WorkflowHost<"interactive">, installationId: string) {
  return wikiAdapter(host, installationId).setup(intakeGraph);
}
export { assertionBody };

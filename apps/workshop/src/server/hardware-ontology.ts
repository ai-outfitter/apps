// Workshop owns the hardware vocabulary: parts, design files, telemetry and
// the Design concept definition. It adds them to the owner's Wiki on
// initialize, the way Foundry adds its feature request types.
import seed from "../../seeds/hardware-v1.json";
import { wikiGraph } from "@ai-outfitter/app-sdk/graph-contracts";
import { wikiAdapter } from "@ai-outfitter/app-sdk/graph-client";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
export const hardwareOntology = wikiGraph.parse(seed);
export const setupHardware = (
  host: WorkflowHost<"interactive">,
  installationId: string,
) => wikiAdapter(host, installationId).setup(hardwareOntology);

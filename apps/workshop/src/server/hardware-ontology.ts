// Workshop owns the hardware vocabulary: parts, design files, telemetry and
// the Design concept definition. It adds them to the owner's Wiki on
// initialize, the way Foundry adds its feature request types.
import seed from "../../seeds/hardware-v1.json";
import { wikiAdapter, wikiGraph } from "@ai-outfitter/app-sdk/wiki";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
export const hardwareOntology = wikiGraph.parse(seed);
export const setupHardware = (
  host: WorkflowHost<"interactive">,
  installationId: string,
) => wikiAdapter(host, installationId).setup(hardwareOntology);

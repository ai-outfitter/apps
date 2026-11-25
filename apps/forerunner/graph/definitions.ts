import type { GraphContribution } from "@ai-outfitter/app-sdk/graph-authoring";
import controls from "../seeds/control-pilot-types-v1.json";
import discovery from "../seeds/discovery-graph-v1.json";

export default [
  { name: "control-pilot-types-v1", scope: "standard", types: controls },
  { name: "discovery-graph-v1", scope: "standard", types: discovery },
] as GraphContribution[];

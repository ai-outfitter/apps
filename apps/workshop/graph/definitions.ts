import type { GraphContribution } from "@ai-outfitter/app-sdk/graph-authoring";
import hardware from "../seeds/hardware-v1.json";

export default [
  { name: "hardware-v1", scope: "addon", ...hardware },
] as GraphContribution[];

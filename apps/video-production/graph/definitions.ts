import type { GraphContribution } from "@ai-outfitter/app-sdk/graph-authoring";
import { videoTypes } from "./video-production";

export default [
  // Video Production shipped its own CreativeBrief and Storyboard before the shared
  // definitions. Validate that registry separately to keep its public names and UUIDs.
  { name: "video-production", scope: "addon", legacyAlternatives: ["creative-team/creative-v1"], ...videoTypes },
] as GraphContribution[];

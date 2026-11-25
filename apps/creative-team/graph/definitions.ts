import type { GraphContribution } from "@ai-outfitter/app-sdk/graph-authoring";
import creative from "../seeds/creative-v1.json";
import { brandWikiTypes } from "./brand-interview";

export default [
  { name: "creative-v1", scope: "standard", ...creative },
  { name: "brand-interview", scope: "addon", ...brandWikiTypes },
] as GraphContribution[];

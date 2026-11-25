import type { GraphContribution } from "@ai-outfitter/app-sdk/graph-authoring";
import work from "../seeds/work-graph-v1.json";
import { codeChangeGraph } from "./code-changes";
import { intakeGraph } from "./intake";
import { measurementGraph } from "./measurements";
import { useCaseGraph } from "./use-cases";

export default [
  { name: "work-graph-v1", scope: "standard", types: work },
  { name: "code-changes", scope: "addon", ...codeChangeGraph },
  { name: "intake", scope: "addon", ...intakeGraph },
  { name: "measurements", scope: "addon", ...measurementGraph },
  { name: "use-cases", scope: "addon", ...useCaseGraph },
] as GraphContribution[];

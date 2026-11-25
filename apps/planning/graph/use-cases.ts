import type { AuthoredGraph } from "@ai-outfitter/app-sdk/graph-authoring";
import { z } from "zod";
import { schemaJSON } from "@ai-outfitter/app-sdk/agent-schema";
export const useCaseTypeId = "ec742645-38b4-4b1e-a25a-77e3757b9f05";
const prose = (description: string) =>
  z.string().max(2500).describe(description);
export const useCaseBody = z.strictObject({
  actor: prose("Who is trying to accomplish the goal?"),
  goal: prose("The outcome the actor needs."),
  trigger: prose("What starts the use case, including any preconditions."),
  steps: prose("The normal sequence of actions."),
  alternatives: prose("Other paths, failures and recovery."),
  successCriteria: prose("Observable evidence that the goal was achieved."),
});
export const useCaseGraph = {
  types: [
    {
      id: useCaseTypeId,
      category: "node",
      name: "UseCase",
      title: "Use case",
      body: "An actor's goal and the scenario that achieves it. Authored in Planning and stored in Wiki. Project association is a reference by installation and project ID, not a copy of the project.",
      jsonSchema: schemaJSON(useCaseBody),
      properties: [
        {
          name: "planning_installation_id",
          type: "string",
          required: true,
          description: "Installation owning the associated Planning project.",
        },
        {
          name: "project_id",
          type: "string",
          required: true,
          description: "Associated canonical Planning project ID.",
        },
      ],
    },
  ],
  nodes: [],
  edges: [],
} satisfies Pick<AuthoredGraph, "types" | "nodes" | "edges">;

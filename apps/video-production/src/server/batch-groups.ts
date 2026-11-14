import type { BatchGroups } from "@ai-outfitter/app-sdk/batch-documents";

// The *Changes documents agents run with graph_mutate.
export const batchGroups = {
  StoryboardChanges: {
    description: "Stage a creative brief, a storyboard, its shots and their visual references in the organization's Onto as one change batch for review",
    actions: { stageStoryboard: "stageStoryboard" },
  },
} satisfies BatchGroups;

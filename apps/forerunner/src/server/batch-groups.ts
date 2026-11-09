import type { BatchGroups } from "@ai-outfitter/app-sdk/batch-documents";

export const batchGroups = {
  "ItemChanges": {
    "description": "Apply item changes using explicit actions",
    "actions": {
      "createItem": "createItem",
      "updateItem": "updateItem",
      "deleteItem": "deleteItem",
      "reorderItems": "reorderItems"
    }
  },
  SuggestionChanges: {
    description: "Act on the daily run's suggestions: update one to applied (turn a workflow on or rewrite its routine) or dismissed (set it aside). Read Suggestions for the ids.",
    actions: { update: "updateSuggestion" },
  },
} satisfies BatchGroups;

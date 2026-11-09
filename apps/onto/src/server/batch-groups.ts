import type { BatchGroups } from "@ai-outfitter/app-sdk/batch-documents";

export const batchGroups = {
  "ChangeBatchChanges": {
    "resultFields": ["id", "title", "state", "counts", "reviewBy"],
    "description": "Apply changebatch changes using explicit actions",
    "actions": {
      "stage": "stageChanges",
      "remove": "removeStagedChanges",
      "submit": "submitBatch",
      "review": "reviewBatch"
    }
  }
} satisfies BatchGroups;

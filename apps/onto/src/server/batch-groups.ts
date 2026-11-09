import type { BatchGroups } from "@ai-outfitter/app-sdk/batch-documents";

export const batchGroups = {
  "ChangeBatchChanges": {
    "resultFields": ["id", "title", "state", "counts", "reviewBy", "anchors", "validation"],
    "description": "Apply changebatch changes using explicit actions",
    "actions": {
      "amend": "reviseBatch",
      "stage": "stageChanges",
      "configure": "configureBatch",
      "remove": "removeStagedChanges",
      "submit": "submitBatch",
      "review": "reviewBatch"
    }
  }
} satisfies BatchGroups;

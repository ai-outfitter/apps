import type { BatchGroups } from "@ai-outfitter/app-sdk/batch-documents";
import { batchReviewUrl } from "./graphql";

export const batchGroups = {
  "ChangeBatchChanges": {
    "resultFields": ["id", "title", "state", "counts", "reviewBy", "reviewUrl", "anchors", "validation"],
    reviewUrl: (_context, value) => value && typeof value === "object" && "id" in value ? batchReviewUrl(String(value.id)) : undefined,
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

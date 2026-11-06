import type { BatchGroups } from "@ai-outfitter/app-sdk/batch-documents";

export const batchGroups = {
  RequestChanges:{description:"Submit feature and bug requests for intake and triage",actions:{submit:"submitRequest"}},
  "ProjectChanges": {
    "description": "Apply project changes using explicit actions",
    "actions": {
      "createProject": "createProject"
    }
  },
  "WorkChanges": {
    "description": "Apply work changes using explicit actions",
    "actions": {
      "submitWork": "submitWork",
      "startWork": "startWork"
    }
  }
} satisfies BatchGroups;

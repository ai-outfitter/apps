import type { BatchGroups } from "@ai-outfitter/app-sdk/batch-documents";

export const batchGroups = {
  RequestChanges:{description:"File feature and bug requests: each opens a GitHub issue and starts Foundry's workflow",actions:{submit:"submitRequest"}},
  "ProjectChanges": {
    "description": "Apply project changes using explicit actions",
    "actions": {
      "createProject": "createProject"
    }
  }
} satisfies BatchGroups;

import type { BatchGroups } from "@ai-outfitter/app-sdk/batch-documents";

export const batchGroups = {
  RequestChanges:{description:"File feature and bug requests: each opens a GitHub issue and starts Foundry's workflow",actions:{submit:"submitRequest",resume:"resumeRequest"}},
  RepositoryChanges:{description:"Turn Foundry execution on for a repository",actions:{enable:"enableRepository"}},
  JobChanges:{description:"Run or schedule Foundry's repository jobs",actions:{run:"runJob",schedule:"scheduleJob"}},
  "ProjectChanges": {
    "description": "Apply project changes using explicit actions",
    "actions": {
      "createProject": "createProject"
    }
  }
} satisfies BatchGroups;

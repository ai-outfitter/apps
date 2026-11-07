import type { BatchGroups } from "@ai-outfitter/app-sdk/batch-documents";

// The *Changes documents agents run with graph_mutate: each item names one of the
// mutations below, which check access and revisions themselves.
export const batchGroups = {
  BrandChanges: {
    description: "Save brand interview answers using explicit actions",
    actions: { saveBrandAnswer: "saveBrandAnswer" },
  },
  ContentChanges: {
    description: "Save content document sources and the content profile using explicit actions",
    actions: { saveSource: "saveSource", deleteSource: "deleteSource", saveContentProfile: "saveContentProfile" },
  },
  MapChanges: {
    description: "Add, change or remove content map pillars, topics, ideas and angles using explicit actions",
    actions: { addMapBranch: "addMapBranch", saveMapNode: "saveMapNode", deleteMapNode: "deleteMapNode" },
  },
  DraftChanges: {
    description: "Save or remove post drafts using explicit actions",
    actions: { saveDraft: "saveDraft", deleteDraft: "deleteDraft" },
  },
} satisfies BatchGroups;

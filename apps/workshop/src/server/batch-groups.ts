import type { BatchGroups } from "@ai-outfitter/app-sdk/batch-documents";

export const batchGroups = {
  "ProjectChanges": {
    "description": "Apply project changes using explicit actions",
    "actions": {
      "createWorkshopProject": "createWorkshopProject",
      "describeWorkshopProject": "describeWorkshopProject",
      "deleteWorkshopProject": "deleteWorkshopProject"
    }
  },
  "UnitChanges": {
    "description": "Apply unit changes using explicit actions",
    "actions": {
      "recordWorkshopUnit": "recordWorkshopUnit",
      "updateWorkshopUnit": "updateWorkshopUnit",
      "deleteWorkshopUnit": "deleteWorkshopUnit"
    }
  },
  "ConceptChanges": {
    "description": "Apply concept changes using explicit actions",
    "actions": {
      "publishWorkshopConcepts": "publishWorkshopConcepts",
      "removeWorkshopConcept": "removeWorkshopConcept"
    }
  },
  "AssemblyChanges": {
    "description": "Apply assembly changes using explicit actions",
    "actions": {
      "saveWorkshopAssembly": "saveWorkshopAssembly"
    }
  },
  "ProductRevisionChanges": {
    "description": "Apply productrevision changes using explicit actions",
    "actions": {
      "nameWorkshopProductRevision": "nameWorkshopProductRevision"
    }
  }
} satisfies BatchGroups;

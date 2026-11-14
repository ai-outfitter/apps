import type { BatchGroups } from "@ai-outfitter/app-sdk/batch-documents";

export const batchGroups = {
  MutateProject:{description:"Create, edit with a field mask (including requirements, repository links and the Onto Project node link), archive projects, or retry their delivery preparation",resultFields:["id","name","archived","revision","requirementChanges","repositoryChanges","projectNodeChanges","preparation","run","instructions"],actions:{create:"createProject",edit:"patchProject",archive:"archiveProject",prepare:"prepareProject"}},
  "ProjectChanges": {
    "description": "Apply project changes using explicit actions",
    "actions": {
      "createProject": "createProject",
      "updateProject": "updateProject",
      "deleteProject": "deleteProject"
    }
  },
  "IssueChanges": {
    "description": "Apply issue changes using explicit actions",
    "actions": {
      "createIssue": "createIssue",
      "updateIssue": "updateIssue",
      "deleteIssue": "deleteIssue",
      "reorderIssues": "reorderIssues"
    }
  },
  "IntakeChanges": {
    "description": "Apply intake changes using explicit actions",
    "actions": {
      "createIntake": "createIntake",
      "routeIntake": "routeIntake",
      "reviseIntakeScope": "reviseIntakeScope",
      "resetIntakeSubmission": "resetIntakeSubmission",
      "submitIntakeWork": "submitIntakeWork",
      "submitDeliveryPackage": "submitDeliveryPackage"
    }
  },
  "ResultChanges": {
    "description": "Apply result changes using explicit actions",
    "actions": {
      "claimWork": "claimWork",
      "saveResultDraft": "saveResultDraft",
      "recordResult": "recordResult",
      "publishResult": "publishResult"
    }
  },
  "UseCaseChanges": {
    "description": "Apply usecase changes using explicit actions",
    "actions": {
      "saveUseCase": "saveUseCase"
    }
  }
} satisfies BatchGroups;

export const readGroups = {IntakeWorkPreviews:{field:"intakeWorkPreview",description:"Preview selected intake routes before submitting work"}};

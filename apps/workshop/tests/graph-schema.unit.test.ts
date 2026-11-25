import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { graphSchema } from "../scripts/graph-schema";

test("the committed GraphQL schema, types and documents match what graph.graphql and graph.mutate serve", async () => {
  assert.deepEqual(await graphSchema({ check: true }), [], "run node --import tsx apps/workshop/scripts/graph-schema.ts");
  // The routes' own documents, plus the collection reads and *Changes batch documents agents discover.
  const committed = JSON.parse(await readFile(new URL("../graph/documents.json", import.meta.url), "utf8"));
  assert.deepEqual(committed.map((row: { name: string; kind: string }) => [row.name, row.kind]), [
    ["AcceptCreativeHandoff","mutation"], ["AssemblyChanges", "mutation"], ["AttachCreativeResult","mutation"], ["ClaimWorkshopBuild", "mutation"], ["ConceptChanges", "mutation"], ["CreateWorkshopProject", "mutation"], ["DeleteWorkshopProject", "mutation"], ["DeleteWorkshopUnit", "mutation"],
    ["DescribeWorkshopProject", "mutation"], ["FinishWorkshopBuild", "mutation"], ["NameWorkshopProductRevision", "mutation"], ["ProductRevisionChanges", "mutation"], ["ProjectChanges", "mutation"], ["PublishWorkshopConcepts", "mutation"],
    ["RecordWorkshopCotsEvidence", "mutation"], ["RecordWorkshopPrintPlate", "mutation"], ["RecordWorkshopUnit", "mutation"], ["RemoveWorkshopConcept", "mutation"], ["RequestWorkshopBuild", "mutation"], ["ResolvedWorkshopAssembly","query"], ["ResolvedWorkshopAssemblyPage","query"], ["SaveWorkshopAssembly", "mutation"], ["StartWorkshopDesign", "mutation"], ["SubmitWorkshopPcb", "mutation"], ["UnitChanges", "mutation"], ["UpdateWorkshopAssembly", "mutation"], ["UpdateWorkshopUnit", "mutation"], ["UploadWorkshopAssemblyFile","mutation"], ["VerifyWorkshopAssemblyFile","query"], ["WorkshopAssembly", "query"], ["WorkshopCotsEvidence", "query"], ["WorkshopDesignRun", "query"], ["WorkshopPrint", "query"], ["WorkshopProjectHandoff", "query"],
    ["WorkshopProjects", "query"], ["WorkshopSourceFile", "query"], ["WorkshopUnits", "query"],
  ]);
  // Public documents are the operations a workspace agent can discover.
  assert.deepEqual(committed.filter((row: { hidden?: boolean }) => !row.hidden).map((row: { name: string }) => row.name), ["AcceptCreativeHandoff", "AttachCreativeResult", "CreateWorkshopProject", "DescribeWorkshopProject", "RecordWorkshopCotsEvidence", "RecordWorkshopPrintPlate", "ResolvedWorkshopAssembly", "ResolvedWorkshopAssemblyPage", "StartWorkshopDesign", "SubmitWorkshopPcb", "UpdateWorkshopAssembly", "UploadWorkshopAssemblyFile", "VerifyWorkshopAssemblyFile", "WorkshopAssembly", "WorkshopCotsEvidence", "WorkshopDesignRun", "WorkshopPrint", "WorkshopProjects", "WorkshopSourceFile"]);
});

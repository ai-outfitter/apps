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
    ["RecordWorkshopUnit", "mutation"], ["RemoveWorkshopConcept", "mutation"], ["RequestWorkshopBuild", "mutation"], ["SaveWorkshopAssembly", "mutation"], ["UnitChanges", "mutation"], ["UpdateWorkshopUnit", "mutation"], ["WorkshopProjectHandoff", "query"],
    ["WorkshopProjects", "query"], ["WorkshopUnits", "query"],
  ]);
});

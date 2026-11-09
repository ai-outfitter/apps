import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { graphSchema } from "../scripts/graph-schema";

test("the committed GraphQL schema, types and documents match what graph.graphql and graph.mutate serve", async () => {
  assert.deepEqual(await graphSchema({ check: true }), [], "run node --import tsx apps/planning/scripts/graph-schema.ts");
  // Every document is a write a page route or an agent runs, or a read agents are pointed at.
  const committed = JSON.parse(await readFile(new URL("../graph/documents.json", import.meta.url), "utf8"));
  assert.deepEqual(committed.filter((row:{hidden?:boolean})=>!row.hidden).map((row:{name:string;kind:string})=>[row.name,row.kind]),[
    ["ChangeProductReportSchedule","mutation"],["GenerateProductReport","mutation"],["MutateProject","mutation"],["OrganizationGoals","query"],["PriorityOrder","query"],["ProductReportRuns","query"],["ProductReportSchedule","query"],["Products","query"],["ProductSummaries","query"],["ProjectDelivery","query"],["ProjectRepositories","query"],["Projects","query"],["ProjectSummaries","query"],["ReorderPriority","mutation"],["SetProjectState","mutation"],
  ]);
  assert.equal(committed.find((row:{name:string})=>row.name==="CreateProject")?.hidden,true,"legacy execution remains hidden");
});

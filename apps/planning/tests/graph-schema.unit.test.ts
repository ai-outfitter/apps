import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { graphSchema } from "../scripts/graph-schema";

test("the committed GraphQL schema, types and documents match what graph.graphql and graph.mutate serve", async () => {
  assert.deepEqual(await graphSchema({ check: true }), [], "run node --import tsx apps/planning/scripts/graph-schema.ts");
  // Every document is a write a page route or an agent runs, or a read agents are pointed at.
  const committed = JSON.parse(await readFile(new URL("../graph/documents.json", import.meta.url), "utf8"));
  assert.deepEqual(committed.filter((row:{hidden?:boolean})=>!row.hidden).map((row:{name:string;kind:string})=>[row.name,row.kind]),[["ChangeDigestSchedule", "mutation"], ["ChangeProductReportSchedule", "mutation"], ["ClaimWork", "mutation"], ["CreateIntake", "mutation"], ["DailyReport", "query"], ["DailyReports", "query"], ["DigestRuns", "query"], ["DigestSchedule", "query"], ["GenerateDailyReports", "mutation"], ["GenerateProductReport", "mutation"], ["GenerateProjectDigest", "mutation"], ["IntakeReleaseOptions", "query"], ["Intakes", "query"], ["IntakeWorkPreview", "query"], ["IssueChanges", "mutation"], ["Issues", "query"], ["MutateProject", "mutation"], ["OrganizationGoals", "query"], ["PersonalPortfolio", "query"], ["PortfolioProjects", "query"], ["PriorityOrder", "query"], ["ProductReportRuns", "query"], ["ProductReportSchedule", "query"], ["Products", "query"], ["ProductSummaries", "query"], ["ProjectDelivery", "query"], ["ProjectDigests", "query"], ["ProjectRepositories", "query"], ["Projects", "query"], ["ProjectSummaries", "query"], ["PublishResult", "mutation"], ["RecordResult", "mutation"], ["ReorderPersonalPortfolio", "mutation"], ["ReorderPriority", "mutation"], ["ResetIntakeSubmission", "mutation"], ["ReviseIntakeScope", "mutation"], ["RouteIntake", "mutation"], ["SaveResultDraft", "mutation"], ["SaveUseCase", "mutation"], ["SetIntakeReleaseFit", "mutation"], ["SetProjectState", "mutation"], ["SubmitIntakeWork", "mutation"], ["UseCases", "query"]]);
  assert.equal(committed.find((row:{name:string})=>row.name==="CreateProject")?.hidden,true,"legacy execution remains hidden");
});

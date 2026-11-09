import assert from "node:assert/strict";
import test from "node:test";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { changeProductReportSchedule, productReportRuns, productReportSchedule, productReportWorkflow, startProductReport } from "../src/server/product-report-workflow";

function fixture() {
  const calls: {name: string; input: unknown}[] = [];
  const host = {call: async (name: string, input: unknown) => {
    calls.push({name, input});
    if (name === "schedules") return [
      {workflowId: "unrelated", enabled: true},
      {workflowId: productReportWorkflow, enabled: false, nextRunAt: null, lastRunAt: "2026-11-06", lastOutcome: "failed"},
    ];
    if (name === "workflow.activity") return {items: [{id: "run", status: "failed", createdAt: "start", updatedAt: "end", privateDetail: "omitted"}]};
    return {ok: true};
  }} as unknown as WorkflowHost<"interactive">;
  const identity: AppIdentity = {userId: "editor", organizationId: "org", owner: {kind: "organization", id: "org"}, installationId: "planning", role: "admin", canEdit: true};
  return {calls, host, identity};
}

test("roadmap schedule and run history read the registered workflow through the scoped host", async () => {
  const {host, calls} = fixture();
  assert.deepEqual(await productReportSchedule(host), {enabled: false, nextRunAt: null, lastRunAt: "2026-11-06", lastOutcome: "failed"});
  assert.deepEqual(await productReportRuns(host), [{id: "run", status: "failed", createdAt: "start", updatedAt: "end"}]);
  assert.deepEqual(calls, [{name: "schedules", input: {}}, {name: "workflow.activity", input: {workflows: [productReportWorkflow], limit: 10}}]);
});

test("roadmap execution and scheduling require editor authority before dispatch", async () => {
  const {host, calls, identity} = fixture();
  const reader = {...identity, canEdit: false};
  await assert.rejects(changeProductReportSchedule(host, reader, {enabled: true}), error => error instanceof Response && error.status === 403);
  await assert.rejects(startProductReport(host, reader), error => error instanceof Response && error.status === 403);
  assert.equal(calls.length, 0);
  await changeProductReportSchedule(host, identity, {enabled: true});
  await startProductReport(host, identity);
  assert.deepEqual(calls[0], {name: "schedule.save", input: {workflow: productReportWorkflow, timezone: "UTC", enabled: true, inputs: {}}});
  assert.equal(calls[1].name, "task.start");
  assert.equal((calls[1].input as {task: string}).task, productReportWorkflow);
});

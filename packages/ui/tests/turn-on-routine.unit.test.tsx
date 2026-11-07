import assert from "node:assert/strict";
import test from "node:test";
import { runPath, turnedOnMessage } from "../src/react/chat/turn-on-routine";

test("first-run links use the recurring task workflow and encode the run ID", () => {
  assert.equal(runPath("run/one"), "/workflows/recurring-task/runs/run%2Fone");
  assert.match(turnedOnMessage("Task", { scheduleId: "schedule", runId: "run/one", status: "running" }), /\[First run\]\(\/workflows\/recurring-task\/runs\/run%2Fone\)/);
});

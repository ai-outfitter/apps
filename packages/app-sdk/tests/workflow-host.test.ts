import assert from "node:assert/strict";
import test from "node:test";
import { operationAllowed, operations, workflowPhases } from "../src/workflow-host";

test("a scheduled invocation acts for no member: only operations that name it explicitly are callable", () => {
  const callable = Object.keys(operations).filter((name) => operationAllowed(name, "invocation")).sort();
  assert.deepEqual(callable, ["agent-task.cancel", "agent-task.inspect", "agent-task.send", "agent-task.status", "agent-work.context", "agent-work.list", "agent-work.providers", "invocations", "resident.reconcile", "resident.task-authority"]);
  // Member, entity and app-action operations never reach it implicitly.
  for (const name of ["actions.call", "actions.list", "entities.list", "entities.create", "identity.resolve", "workflow.read", "invocation.save", "snapshot", "resident.inspect", "resident.runtimes"])
    assert.equal(operationAllowed(name, "invocation"), false, name);
  // Every other phase still sees its member operations.
  for (const phase of workflowPhases.filter((current) => current !== "invocation"))
    assert.equal(operationAllowed("workflow.read", phase), true, phase);
});

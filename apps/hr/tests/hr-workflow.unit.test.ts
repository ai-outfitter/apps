import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { transitionHiring } from "../src/hr-workflow";
import { hiring } from "../hiring";
test("released HR workflow behavior remains immutable", () => {
  assert.equal(hiring.version, "0.1.0");
  // Changing a released definition requires a new version and retained old entry.
  assert.equal(
    createHash("sha256").update(JSON.stringify(hiring)).digest("hex"),
    "d81c1b59a97115d6fac6be64ed9f40692e7dd04175377007ae06a2dfe4e974a6",
  );
});
test("hiring decisions bind current revisions and human assignments", () => {
  const row = {
    requesterId: "requester",
    approverId: "approver",
    state: "awaiting_approval" as const,
    revision: 1,
  };
  const action = {
    action: "approve" as const,
    revision: 1,
    note: "Headcount approved",
  };
  assert.throws(() => transitionHiring(row, "requester", action));
  assert.throws(() => transitionHiring(row, "admin", action));
  assert.throws(() =>
    transitionHiring(row, "approver", { ...action, revision: 2 }),
  );
  assert.equal(transitionHiring(row, "approver", action), "research_blocked");
  for (const state of ["cancelled", "rejected", "research_blocked"] as const)
    assert.throws(() =>
      transitionHiring({ ...row, state }, "approver", action),
    );
  assert.throws(() => transitionHiring(row, "approver", action, "missing"));
  assert.equal(
    transitionHiring(
      row,
      "requester",
      { action: "cancel", revision: 1, note: "Withdrawn" },
      "missing",
    ),
    "cancelled",
  );
});

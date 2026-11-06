import assert from "node:assert/strict";
import test from "node:test";
import { foundryLandingWorkflow, landingContinuation } from "../src/server/workspace/landing-recovery";

const runId = "101d3c79-2f91-5b62-acfb-a5eb0403c180", head = "a".repeat(40);
function prior() {
  return { run: { id: runId, status: "failed", workflowId: "issue-to-merge-actions-ci" }, state: {
    inputs: { "triage.inputs.event": { repository: { id: 3 }, issue: { number: 17 } } } as Record<string, unknown>,
    rows: { "review-final.outputs.result": { complete: true, value: { ready: true, summary: "Reviewed", passed: true,
      candidate: { number: 18, headSha: head, branch: `outfitter/issue-17-${runId}`, url: "https://github.com/acme/app/pull/18" },
      checks: [{ passed: true, headSha: head }], review: { verdict: "approved", id: 9, headSha: head, reviewer: { id: 20 } },
    } } },
  } };
}
test("failed landing reuses the recorded candidate and review without rewriting the original run", () => {
  const original = prior(), before = JSON.stringify(original);
  const recovery = landingContinuation(original)!;
  assert.equal(recovery.previous, original.state.rows["review-final.outputs.result"].value);
  assert.equal(recovery.sourceRunId, runId);
  assert.equal(recovery.previousRunId, runId);
  assert.equal(JSON.stringify(original), before);
});
test("partial review, failed CI, stale review, wrong branch and active runs cannot seed landing", () => {
  const cases = [
    (p: ReturnType<typeof prior>) => { p.run.status = "running"; },
    (p: ReturnType<typeof prior>) => { p.state.rows["review-final.outputs.result"].complete = false; },
    (p: ReturnType<typeof prior>) => { p.state.rows["review-final.outputs.result"].value.passed = false; },
    (p: ReturnType<typeof prior>) => { p.state.rows["review-final.outputs.result"].value.review.headSha = "b".repeat(40); },
    (p: ReturnType<typeof prior>) => { p.state.rows["review-final.outputs.result"].value.candidate.branch = "unrelated"; },
  ];
  for (const mutate of cases) { const p = prior(); mutate(p); assert.equal(landingContinuation(p), undefined); }
});
test("a failed landing continuation preserves the original implementation branch on another restart", () => {
  const first = prior(), recovery = landingContinuation(first)!;
  const second = { run: { id: "381fd2e1-fc96-4e19-b6e0-e120f46bf982", status: "failed", workflowId: foundryLandingWorkflow }, state: {
    inputs: { "land.inputs.previous": recovery.previous, "land.inputs.sourceRunId": recovery.sourceRunId,
      "land.inputs.event": first.state.inputs["triage.inputs.event"] }, rows: {},
  } };
  assert.equal(landingContinuation(second)?.sourceRunId, runId);
  assert.equal(landingContinuation(second)?.previousRunId, second.run.id);
});

test("an interrupted redundant final review can retain an unchanged approval after fresh validation", () => {
  const first = prior();
  const validated = first.state.rows["review-final.outputs.result"];
  const interrupted = { ...first, state: { ...first.state, rows: {
    "review-final.outputs.result": { complete: false, value: null },
    "validate-final.outputs.result": structuredClone(validated),
  } } };
  const reason = "The environment stopped unexpectedly during this run. Review its output before trying again in a new workspace.";
  const before = JSON.stringify(interrupted);
  assert.equal(landingContinuation(interrupted), undefined);
  assert.equal(landingContinuation(interrupted, "A test failed"), undefined);
  assert.equal(landingContinuation(interrupted, reason)?.previous, interrupted.state.rows["validate-final.outputs.result"].value);
  assert.equal(JSON.stringify(interrupted), before);
  interrupted.state.rows["validate-final.outputs.result"].value.review.headSha = "b".repeat(40);
  assert.equal(landingContinuation(interrupted, reason), undefined);
});

test("completed requested changes and repaired commits without approval cannot fall back to an older approval", () => {
  const first = prior();
  const approved = structuredClone(first.state.rows["review-final.outputs.result"]);
  const reason = "The environment stopped unexpectedly during this run. Review its output before trying again in a new workspace.";
  const rejected = { ...first, state: { ...first.state, rows: { ...first.state.rows, "validate-final.outputs.result": approved } } };
  rejected.state.rows["review-final.outputs.result"].value.review.verdict = "changes-requested";
  assert.equal(landingContinuation(rejected, reason), undefined);
  const changed = { ...first, state: { ...first.state, rows: {
    "validate-final.outputs.result": { complete: true, value: { ...approved.value,
      candidate: { ...approved.value.candidate, headSha: "b".repeat(40) }, review: null,
    } },
  } } };
  assert.equal(landingContinuation(changed, reason), undefined);
});


test("landing after branch-preserving recovery distinguishes PR ownership from new evidence", () => {
  const p = prior(), original = "11111111-1111-4111-8111-111111111111";
  (p.state.inputs["triage.inputs.event"] as Record<string, unknown>).sourceRunId = original;
  p.state.rows["review-final.outputs.result"].value.candidate.branch = `outfitter/issue-17-${original}`;
  const next = landingContinuation(p)!;
  assert.equal(next.branchRunId, original);
  assert.equal(next.sourceRunId, runId, "screenshots remain owned by the run that produced them");
});

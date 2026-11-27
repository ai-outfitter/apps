import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { api, inspectCandidate, inventory } from "./fixture.mjs";
import { waitFor } from "./grants.mjs";
import { checkoutProof } from "./recovery-seed.mjs";

const requestId = "00000000-0000-4000-8000-000000000011";
const otherRequest = "00000000-0000-4000-8000-000000000012";
const current = { title: "Record the updated lamp setting",
  body: "Update README so the synthetic lamp uses teal. Preserve all other files." };
const intermediateIssue = { title: "Record a preliminary lamp setting",
  body: "Update README so the synthetic lamp uses indigo." };
const chainRequest = "00000000-0000-4000-8000-000000000013";
const currentContent = "# Synthetic lamp\n\nSetting: teal.\n";
const lines = path => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);

async function editIssue(auth, out, issuePath, edit) {
  const permit = out("allow-fixture-issue-edit");
  writeFileSync(permit, "");
  try {
    const updated = await api(auth.admin, issuePath, "PATCH", edit);
    assert.deepEqual({ title: updated.title, body: updated.body }, edit);
  } finally {
    rmSync(permit, { force: true });
  }
}

export async function exerciseRestart({ auth, report, pin, out, runs, settle, auditPull, gradeResolution,
  db, mutate, progress, originalId, frozenAppReview, frozenRun, frozenAttempts, loadAppReviews, readRun, attempts,
  nativeWrites, repoPath, responseReceipt }) {
  const originalInputs = JSON.parse(frozenAppReview.inputs);
  const originalIssue = originalInputs["implement.inputs.issue"];
  const savedRuns = runs();
  const records = () => inventory(auth.admin);
  const writeJournal = out("forgejo-requests.jsonl");
  const writes = () => nativeWrites(writeJournal);
  const issuePath = `${repoPath}/issues/${pin.issueNumber}`;
  const originalPath = `/api/v1${repoPath}/branches/outfitter-review-${originalId}`;
  const restart = (request = requestId, runId = originalId) =>
    mutate({ action: "RESTART", runId, requestId: request });
  const recover = () => mutate({ action: "RECOVER", runId: originalId });
  const receipt = result => responseReceipt(result, "ReviewIssue");

  let parentId = originalId;
  let edit = current;
  let failedContinuation;
  if (report.case === "restart-chain") edit = intermediateIssue;
  await editIssue(auth, out, issuePath, edit);
  let edited = await records();
  assert.deepEqual(edited.issues, report.before.issues.map(issue => ({ ...issue, ...edit })));
  assert.deepEqual(edited.refs, report.before.refs);
  assert.deepEqual(edited.pulls, []);
  report.issueSnapshots = { original: originalIssue, edited: edited.issues[0] };
  const beforeWrites = writes();
  const refused = async (name, call, snapshot = edited) => {
    const before = writes();
    const result = await call();
    assert.equal(result.refused, true, `${name}: ${result.text}`);
    assert.deepEqual(writes(), before, name);
    assert.deepEqual(await records(), snapshot, name);
    report.refusals.push({ scenario: name, refused: true, additionalWrites: 0, error: result.text.slice(0, 300) });
  };
  await refused("recover-after-issue-edit", recover);
  assert.deepEqual(runs(), savedRuns);
  assert.deepEqual(loadAppReviews(), [frozenAppReview]);

  if (report.case === "restart-uncertain") {
    writeFileSync(out("refuse-reconciliation"), originalPath);
    try {
      await refused("unknown-provider-state", restart);
      assert.ok(lines(writeJournal).some(event => event.path === originalPath &&
        event.injected === "unknown-reconciliation-read" && event.status === 503));
    } finally {
      rmSync(out("refuse-reconciliation"), { force: true });
    }
    assert.deepEqual(writes(), beforeWrites);
    const branch = `outfitter-review-${originalId}`;
    await api(auth.worker, `${repoPath}/branches`, "POST", { new_branch_name: branch, old_ref_name: pin.baseRef });
    const nativeUnknown = await records();
    assert.deepEqual(nativeUnknown.refs, { ...edited.refs, [branch]: pin.baseSha });
    await refused("unreceipted-original-branch", restart, nativeUnknown);
    assert.ok(lines(writeJournal).some(event => event.path === originalPath && event.status === 200));
    assert.deepEqual(runs(), savedRuns);
    assert.deepEqual(loadAppReviews(), [frozenAppReview]);
    assert.equal((await progress()).recovery, null);
    assert.ok(!existsSync(out("provider.jsonl")));
    report.final = nativeUnknown;
    return;
  }

  if (report.case === "restart-chain") {
    const fault = out("restart-fail-checkout");
    writeFileSync(fault, "");
    try {
      const accepted = receipt(await restart(chainRequest));
      parentId = accepted.recovery?.id;
      assert.ok(parentId && parentId !== originalId);
      assert.equal((await settle(parentId)).status, "failed");
    } finally {
      rmSync(fault, { force: true });
    }
    assert.ok(existsSync(out("restart-checkout-fault.log")));
    assert.ok(!existsSync(out("provider.jsonl")));
    const [attempt] = attempts(parentId);
    assert.equal(JSON.parse(attempt.receipt).failure.message, checkoutProof);
    assert.deepEqual(writes(), beforeWrites);
    assert.deepEqual(await records(), edited);
    const row = loadAppReviews().find(item => item.runId === parentId);
    assert.equal(row.recoveryOf, originalId);
    assert.deepEqual(JSON.parse(row.inputs)["implement.inputs.issue"], { ...originalIssue, ...intermediateIssue });
    failedContinuation = { row, run: readRun(parentId), attempts: attempts(parentId) };
    await editIssue(auth, out, issuePath, current);
    edited = await records();
    report.issueSnapshots.intermediate = intermediateIssue;
    report.issueSnapshots.edited = edited.issues[0];
    const earlierReplay = receipt(await restart(chainRequest));
    assert.equal(earlierReplay.recovery.id, parentId);
    assert.equal(earlierReplay.recovery.status, "failed");
    assert.deepEqual(writes(), beforeWrites);
  }

  const providerPath = out("provider-context.json");
  const provider = JSON.parse(readFileSync(providerPath, "utf8"));
  writeFileSync(providerPath, JSON.stringify({ ...provider, originalIssue: originalIssue.body,
    currentIssue: current.body, currentContent }));
  writeFileSync(out("model-hold"), "implement");
  const startLatest = (request = requestId) => restart(request, parentId);
  const first = startLatest();
  let id;
  try {
    const overlapping = [first, ...Array.from({ length: 4 }, () => startLatest())];
    const accepted = (await Promise.all(overlapping)).map(receipt);
    id = accepted[0].recovery?.id;
    assert.ok(id && id !== originalId && id !== parentId);
    assert.deepEqual(new Set(accepted.map(item => item.recovery?.id)), new Set([id]));
    report.restart = { requestId, originalId, id, contenderIds: accepted.map(item => item.recovery.id) };
    await waitFor(() => existsSync(out("model-held.json")), "edited issue reached the pinned implementer");
    assert.equal((await progress()).recovery.id, id);
    await refused("different-request-while-active", () => startLatest(otherRequest));
    await refused("restart-active-successor", () => restart(otherRequest, id));
    await refused("unmodified-recovery-after-restart", recover);
    assert.deepEqual(writes(), beforeWrites);
  } finally {
    writeFileSync(out("model-release"), "");
  }

  report.settled = await settle(id);
  assert.equal(report.settled.status, "complete");
  assert.deepEqual(new Set(runs().map(run => run.id)), new Set([originalId, parentId, id]));
  assert.deepEqual(readRun(originalId), frozenRun);
  assert.deepEqual(attempts(originalId), frozenAttempts);
  const rows = loadAppReviews();
  assert.equal(rows.length, failedContinuation ? 3 : 2);
  if (failedContinuation) {
    assert.deepEqual(rows.find(row => row.runId === parentId), failedContinuation.row);
    assert.deepEqual(readRun(parentId), failedContinuation.run);
    assert.deepEqual(attempts(parentId), failedContinuation.attempts);
  }
  assert.deepEqual(rows.find(row => row.runId === originalId), frozenAppReview);
  const child = rows.find(row => row.runId === id);
  assert.equal(child.recoveryOf, parentId);
  assert.deepEqual(JSON.parse(child.inputs), { ...originalInputs,
    "implement.inputs.issue": { ...originalIssue, ...current },
    "implement.inputs.target": { ...originalInputs["implement.inputs.target"], branch: `outfitter-review-${id}` },
  });
  report.final = await records();
  const pr = auditPull({ ...report, before: edited }, report.final);
  const git = inspectCandidate(auth.admin, pin.baseSha, pr.head, pr.headRef);
  assert.deepEqual(git, { head: pr.head, parents: [pin.baseSha], files: ["README.md"], readme: currentContent.trim() });
  report.git = git;
  assert.deepEqual((await api(auth.reviewer, repoPath)).permissions, { admin: false, pull: true, push: false });
  const model = lines(out("provider.jsonl"));
  assert.deepEqual(model.filter(event => event.event === "error"), []);
  assert.deepEqual(model.filter(event => event.event === "response").map(event => [event.actor, event.runId, event.checkout]),
    [["implement", id, pin.baseSha], ["review", id, pr.head]]);
  gradeResolution(db, out, report, id, ["openai", "spark"], ["implement", "review"]);
  const completedWrites = writes();
  assert.deepEqual(completedWrites.slice(beforeWrites.length).map(event => event.path.split("/").at(-1)),
    ["branches", "contents", "pulls", "reviews"]);
  report.progress = await progress();
  assert.equal(report.progress.original.id, originalId);
  assert.equal(report.progress.original.status, "failed");
  assert.equal(report.progress.recovery.id, id);
  assert.equal(report.progress.recovery.status, "complete");
  assert.deepEqual(report.progress.target, pin);
  assert.equal(report.progress.candidate.headSha, pr.head);
  assert.equal(report.progress.review.headSha, pr.head);
  if (failedContinuation) {
    assert.deepEqual(report.progress.lineage.map(run => [run.id, run.status]),
      [[originalId, "failed"], [parentId, "failed"], [id, "complete"]]);
  }
  assert.deepEqual(receipt(await startLatest()), report.progress);
  assert.deepEqual(writes(), completedWrites);
  await refused("different-request-after-publication", () => startLatest(otherRequest), report.final);
  await refused("restart-published-successor", () => restart(otherRequest, id), report.final);
  assert.deepEqual(loadAppReviews(), rows);
  assert.equal(lines(writeJournal).filter(event => event.method === "PATCH" &&
    event.path === `/api/v1${issuePath}`).length, failedContinuation ? 2 : 1);
  report.restart.originalPreserved = true;
  report.restart.postPublicationReplay = id;
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { callTool } from "/planwork/mcp.mjs";
import { api, inspectCandidate, inventory, repoPath } from "./fixture.mjs";
import { waitFor } from "./grants.mjs";
import { checkoutProof, reviewRows, seedPriorReview } from "./recovery-seed.mjs";

const app = "software-foundry";
const reviewDocument = "ReviewIssue";
const progressDocument = "IssueReview";
const unknownRunId = "00000000-0000-5000-a000-000000000001";
const receiptKey = document => document[0].toLowerCase() + document.slice(1);

function jsonLines(path) {
  return readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
}

function nativeWrites(path) {
  return jsonLines(path).filter(({ method, path }) => method === "POST" &&
    (/\/api\/v1\/repos\/.+\/(?:branches|contents|pulls|reviews)$/.test(path) ||
      path.endsWith("/git-receive-pack")));
}

async function withReadOnlyMembership(box, installation, work) {
  const state = new DatabaseSync(box.databases.platform);
  state.exec("PRAGMA busy_timeout=5000");
  const member = state.prepare("SELECT id, role FROM member WHERE organizationId = ? AND userId = 'local-viewer'")
    .get(installation.organizationId);
  assert.ok(member && member.role !== "member");
  const setRole = state.prepare("UPDATE member SET role = ? WHERE id = ?");
  try {
    setRole.run("member", member.id);
    await work();
  } finally {
    setRole.run(member.role, member.id);
    state.close();
  }
}

async function discover(mcp, document, kind) {
  const result = await callTool(mcp, "graph_documents", { scope: "box", search: document, schema: true });
  assert.equal(result.refused, false, result.text);
  const catalog = result.value?.apps?.[app];
  const published = catalog?.[kind]?.[document];
  assert.ok(published?.schema && (published.scopes ?? catalog.scopes).includes("box"),
    `Installed OAuth MCP must advertise ${document} in the fixture organization`);
}

export async function exerciseRecovery({ box, db, auth, mcp, report, pin, workflowId, out, runs, settle,
  auditPull, gradeResolution }) {
  const attempts = id => db.prepare(`SELECT id, nodeId, bindingId, state, outputHash, receipt
    FROM workflow_node_attempts WHERE runId = ? ORDER BY nodeId`).all(id);
  const readRun = id => db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id);
  const currentInventory = () => inventory(auth.admin);
  const writeJournal = out("forgejo-requests.jsonl");
  const beforeWrites = nativeWrites(writeJournal);
  const { runId: originalId, migration } = seedPriorReview(box, report, pin, workflowId);
  const [settled] = runs();
  assert.deepEqual({ ...settled }, { id: originalId, workflowId, status: "failed" });
  assert.equal(runs().length, 1);
  assert.ok(!existsSync(out("provider.jsonl")), "The legacy shape has seen no model inference");
  assert.deepEqual(await currentInventory(), report.before);
  assert.deepEqual(nativeWrites(writeJournal), beforeWrites);
  const loadAppReviews = () => reviewRows(box, report.installation.id);
  const [frozenAppReview] = loadAppReviews();
  assert.equal(frozenAppReview.runId, originalId);
  assert.equal(frozenAppReview.recoveryOf, null);
  const frozenRun = readRun(originalId);
  const frozenAttempts = attempts(originalId);
  assert.equal(frozenAttempts.length, 1);
  const [{ receipt, ...failed }] = frozenAttempts;
  assert.equal(failed.bindingId, report.bindings.implementer);
  assert.equal(failed.nodeId, "implement");
  assert.equal(failed.state, "failed");
  assert.equal(JSON.parse(receipt).failure.message, checkoutProof);
  assert.equal(failed.outputHash, null);
  report.legacy = { run: settled, attempt: failed, ...JSON.parse(receipt), migration };
  if (report.case === "recovery-legacy") {
    report.final = await currentInventory();
    return;
  }

  await discover(mcp, reviewDocument, "mutations");
  await discover(mcp, progressDocument, "queries");
  for (const [oldDocument, kind] of [
    ["ReviewForgejoIssue", "mutations"],
    ["RecoverForgejoIssueReview", "mutations"],
    ["ForgejoIssueReview", "queries"],
  ]) {
    const discovery = await callTool(mcp, "graph_documents", { scope: "box", search: oldDocument, schema: true });
    assert.equal(discovery.refused, false, discovery.text);
    assert.ok(!discovery.value?.apps?.[app]?.[kind]?.[oldDocument], `${oldDocument} stays out of discovery`);
  }
  report.recoveryDocuments = [reviewDocument, progressDocument];
  const query = (runId = originalId, scope = "box") => callTool(mcp, "graph_query",
    { scope, app, document: progressDocument, variables: { runId }, includeIdentifiers: true });
  const mutate = (input, scope = "box", client = mcp) => callTool(client, "graph_mutate",
    { scope, app, document: reviewDocument, variables: { input } });
  const recoverCall = (runId = originalId, scope = "box", client = mcp) =>
    mutate({ action: "RECOVER", runId }, scope, client);
  const startCall = (provider, pins = pin) => mutate({ action: "START", provider, ...pins });
  const progress = async () => responseReceipt(await query(), progressDocument);
  const recover = async (client = mcp) => responseReceipt(await recoverCall(originalId, "box", client), reviewDocument);
  report.beforeRecovery = await progress();
  assert.equal(report.beforeRecovery.provider, "FORGEJO");
  assert.equal(report.beforeRecovery.original.id, originalId);
  assert.equal(report.beforeRecovery.original.status, "failed");
  assert.equal(report.beforeRecovery.recovery, null);
  assert.deepEqual(report.beforeRecovery.target, pin);
  assert.equal(report.beforeRecovery.candidate, null);
  assert.equal(report.beforeRecovery.review, null);
  assert.deepEqual(responseReceipt(await startCall("FORGEJO"), reviewDocument), report.beforeRecovery);
  const mismatch = await startCall("FORGEJO", { ...pin, baseRef: "main" });
  assert.equal(mismatch.refused, true, mismatch.text);
  const github = await startCall("GITHUB", { ...pin, repository: "box/github-review-fixture" });
  assert.equal(github.refused, true, github.text);
  assert.match(github.text + JSON.stringify(github.value ?? {}), /github/i);
  report.providerDispatch = {
    forgejoStartReplayedOriginal: true, forgejoConflictingRefRefused: true,
    githubStartRefusedWithoutGrant: true,
  };
  report.refusals = [];
  for (const [scenario, runId, scope] of [
    ["wrong-tenant", originalId, "unrelated-tenant"],
    ["unknown-run", unknownRunId, "box"],
  ]) {
    const retrieval = await query(runId, scope);
    const mutation = await recoverCall(runId, scope);
    assert.equal(retrieval.refused, true, retrieval.text);
    assert.equal(mutation.refused, true, mutation.text);
    report.refusals.push({ scenario, progressRefused: true, recoveryRefused: true });
  }
  await withReadOnlyMembership(box, report.installation, async () => {
    assert.equal((await progress()).original.id, originalId);
    const result = await recoverCall();
    assert.equal(result.refused, true, result.text);
    report.refusals.push({ scenario: "read-only-member", progressRefused: false, recoveryRefused: true });
  });
  assert.deepEqual(runs(), [settled]);
  assert.deepEqual(loadAppReviews(), [frozenAppReview]);
  assert.deepEqual(nativeWrites(writeJournal), beforeWrites);
  assert.deepEqual(await currentInventory(), report.before);

  if (report.case === "recovery-unknown") {
    // A provider-side artifact with no coordinator receipt makes the old effect ambiguous.
    const oldBranch = `outfitter-review-${originalId}`;
    const introduced = await api(auth.worker, `${repoPath}/branches`, "POST",
      { new_branch_name: oldBranch, old_ref_name: pin.baseRef });
    assert.equal(introduced.name, oldBranch);
    const beforeRefusal = await currentInventory();
    assert.deepEqual(beforeRefusal.refs, { ...report.before.refs, [oldBranch]: pin.baseSha });
    const preRefusalWrites = nativeWrites(writeJournal);
    const beforeAttempt = jsonLines(writeJournal).length;
    const result = await recoverCall();
    assert.equal(result.refused, true, result.text);
    assert.ok(jsonLines(writeJournal).slice(beforeAttempt).some(entry =>
      entry.method === "GET" && entry.status === 200 && entry.path.endsWith(`/branches/${oldBranch}`)),
    "Recovery reconciled the unreceipted original branch before refusing");
    assert.equal((await progress()).recovery, null);
    assert.deepEqual(runs(), [settled]);
    assert.deepEqual(loadAppReviews(), [frozenAppReview]);
    assert.deepEqual(nativeWrites(writeJournal), preRefusalWrites);
    assert.deepEqual(await currentInventory(), beforeRefusal);
    assert.ok(!existsSync(out("provider.jsonl")));
    report.refusals.push({ scenario: "unreceipted-old-branch", recoveryRefused: true });
    report.final = beforeRefusal;
    return;
  }

  writeFileSync(out("drop-publication-responses"), "");
  writeFileSync(out("model-hold"), "implement");
  let deliberatelyLost = false;
  const dropAcceptedReply = async (...args) => {
    const reply = await mcp(...args);
    assert.ok(reply.result && !reply.result.isError, "Recovery reached an accepted OAuth MCP response");
    deliberatelyLost = true;
    throw new Error("Fixture discarded the accepted MCP response");
  };
  writeFileSync(out("forgejo-hold-before.json"), JSON.stringify({
    path: `/api/v1${repoPath}/branches/${pin.baseRef}`,
  }));
  const lostReply = assert.rejects(recover(dropAcceptedReply), /Fixture discarded the accepted MCP response/);
  void lostReply.catch(() => {});
  try {
    await waitFor(() => existsSync(out("forgejo-held-before")), "initial recovery's pinned native read");
    assert.deepEqual(runs(), [settled], "The first recovery is still in admission");
    const overlapping = await Promise.all(Array.from({ length: 4 }, () => recover()));
    writeFileSync(out("forgejo-release-before"), "");
    await lostReply;
    assert.equal(deliberatelyLost, true);
    await waitFor(() => existsSync(out("model-held.json")), "recovery implementer detached at the original base");
    const active = await progress();
    const id = active.recovery?.id;
    const digest = createHash("sha256").update(JSON.stringify([workflowId, "recovery", report.installation.id, originalId])).digest("hex");
    const expected = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    assert.equal(id, expected);
    assert.notEqual(id, originalId);
    assert.equal(active.original.status, "failed");
    assert.equal(active.recovery.status, "running");
    assert.deepEqual(active.target, pin);
    assert.deepEqual(new Set(overlapping.map(receipt => receipt.recovery?.id)), new Set([id]));
    report.overlap = { lostAcceptedReply: deliberatelyLost, active, replayIds: overlapping.map(receipt => receipt.recovery.id) };
  } finally {
    writeFileSync(out("forgejo-release-before"), "");
    writeFileSync(out("model-release"), "");
    await lostReply;
  }
  const id = report.overlap.active.recovery.id;
  report.settled = await settle(id);
  assert.equal(report.settled.status, "complete");
  assert.deepEqual(new Set(runs().map(run => run.id)), new Set([originalId, id]));
  assert.deepEqual(runs().find(run => run.id === originalId), settled);
  assert.deepEqual(readRun(originalId), frozenRun, "Original host run stays intact");
  assert.deepEqual(attempts(originalId), frozenAttempts, "Original host attempt stays intact");
  const preProgressReviews = loadAppReviews();
  assert.equal(preProgressReviews.length, 2);
  assert.deepEqual(preProgressReviews.find(row => row.runId === originalId), frozenAppReview);
  const child = preProgressReviews.find(row => row.runId === id);
  assert.equal(child.recoveryOf, originalId);
  const originalInputs = JSON.parse(frozenAppReview.inputs);
  assert.deepEqual(JSON.parse(child.inputs), { ...originalInputs,
    "implement.inputs.target": { ...originalInputs["implement.inputs.target"], branch: `outfitter-review-${id}` },
  });
  const preProgressWrites = nativeWrites(writeJournal);
  const preProgressRuns = [readRun(originalId), readRun(id), attempts(originalId), attempts(id)];
  const receipts = await Promise.all(Array.from({ length: 3 }, () => progress()));
  assert.ok(receipts.every(receipt => JSON.stringify(receipt) === JSON.stringify(receipts[0])));
  assert.deepEqual(nativeWrites(writeJournal), preProgressWrites);
  assert.deepEqual([readRun(originalId), readRun(id), attempts(originalId), attempts(id)], preProgressRuns);
  assert.deepEqual(loadAppReviews(), preProgressReviews);
  assert.deepEqual(await recover(), receipts[0], "Recovery replay exposes the same final lineage");
  assert.deepEqual(nativeWrites(writeJournal), preProgressWrites);
  report.progressReadOnly = { concurrentQueries: receipts.length, appAndHostUnchanged: true, nativeWritesAdded: 0 };
  report.progress = receipts[0];
  assert.equal(report.progress.provider, "FORGEJO");
  assert.equal(report.progress.original.id, originalId);
  assert.equal(report.progress.original.status, "failed");
  assert.equal(report.progress.recovery.id, id);
  assert.equal(report.progress.recovery.status, "complete");
  assert.deepEqual(report.progress.target, pin);
  report.final = await currentInventory();
  const pr = auditPull(report, report.final);
  assert.deepEqual(await api(auth.reviewer, repoPath).then(repo => repo.permissions), report.reviewerPermissions);
  assert.deepEqual(report.progress.candidate, {
    number: pr.number, url: (await api(auth.admin, `${repoPath}/pulls/${pr.number}`)).html_url,
    headSha: pr.head, branch: pr.headRef, authorId: pr.author,
  });
  const [review] = pr.reviews;
  assert.equal(report.progress.review.id, review.id);
  assert.equal(report.progress.review.reviewer.id, review.actor);
  assert.equal(report.progress.review.headSha, pr.head);
  assert.equal(report.progress.review.verdict, "approved");
  report.git = inspectCandidate(auth.admin, pin.baseSha, pr.head, pr.headRef);
  assert.deepEqual(report.git, { head: pr.head, parents: [pin.baseSha], files: ["README.md"],
    readme: "# Synthetic lamp\n\nSetting: amber." });
  const events = jsonLines(out("provider.jsonl"));
  assert.deepEqual(events.filter(event => event.event === "error"), []);
  report.provider = events.filter(event => event.event === "response");
  assert.deepEqual(report.provider.map(event => [event.actor, event.runId, event.checkout]),
    [["implement", id, pin.baseSha], ["review", id, pr.head]]);
  gradeResolution(db, out, report, id, ["openai", "spark"], ["implement", "review"]);
  report.recoveryWrites = nativeWrites(writeJournal).slice(beforeWrites.length);
  assert.deepEqual(report.recoveryWrites.map(entry => [entry.path.split("/").at(-1), entry.status, entry.dropped]),
    [["branches", 201, true], ["contents", 201, true], ["pulls", 201, true], ["reviews", 200, true]]);
}

function responseReceipt(response, document) {
  assert.equal(response.refused, false, response.text);
  const receipt = response.value?.data?.[receiptKey(document)];
  assert.ok(receipt?.original?.id, response.text);
  return receipt;
}

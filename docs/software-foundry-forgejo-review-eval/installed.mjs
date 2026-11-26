import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTool } from "/planwork/mcp.mjs";
import { inspectCandidate, inventory, issue, pushFixtureCommit } from "./fixture.mjs";
import { sessionRequest, waitFor } from "./grants.mjs";
import { exerciseRecovery } from "./recovery.mjs";

const app = "software-foundry";
const workflowId = "foundry-forgejo-issue-review";
const moved = "# Synthetic lamp\n\nSynthetic concurrent change.\n";
const model = "GLM-5.3-Flash-EXL3";
const sameRun = (rows, id) => rows.length === 1 && rows[0].id === id;
const terminal = status => ["complete", "failed", "canceled", "cancelled"].includes(status);

async function configure(box, db, installation, repositoryId, connectionId) {
  const result = await box.operator({
    operation: "configure-issue-review", repository: issue.repository, repositoryId,
    reviewer: "reviewer", implementerModel: model, reviewerModel: model,
  });
  assert.equal(result.workflow, workflowId);
  assert.equal(result.repository, issue.repository);
  assert.ok(result.implementer && result.reviewer && result.implementer !== result.reviewer);
  const bindings = db.prepare(`SELECT id, actor, kind, enabled, transport FROM workflow_executor_bindings
    WHERE installationId = ? AND workflowId = ? ORDER BY actor`).all(installation.id, workflowId);
  assert.deepEqual(bindings.map(binding => [binding.id, binding.actor, binding.kind, binding.enabled]), [
    [result.implementer, "implementer", "external", 1], [result.reviewer, "reviewer", "external", 1],
  ]);
  for (const row of bindings) {
    const { workspace, context } = JSON.parse(row.transport);
    assert.equal(workspace.checkout, "forgejo-pinned");
    assert.equal(workspace.inferenceProvider, "spark");
    assert.equal(workspace.connectionId, connectionId);
    assert.equal(workspace.repository, issue.repository);
    assert.equal(workspace.resource, String(repositoryId));
    assert.equal(context.model, model);
  }
  return { implementer: result.implementer, reviewer: result.reviewer };
}

function runRows(db, installationId) {
  return db.prepare("SELECT id, workflowId, status FROM workflow_runs WHERE installationId = ? ORDER BY id").all(installationId);
}

function gradeResolution(db, out, report, id, expectedProviders, expectedNodes) {
  const resolutions = readFileSync(out("resolution.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const attempts = db.prepare("SELECT id, nodeId, bindingId FROM workflow_node_attempts WHERE runId = ? ORDER BY nodeId").all(id);
  assert.deepEqual(attempts.map(attempt => attempt.nodeId), expectedNodes);
  for (const attempt of attempts) {
    assert.equal(attempt.bindingId, report.bindings[attempt.nodeId === "implement" ? "implementer" : "reviewer"]);
  }
  assert.deepEqual(new Set(resolutions.map(item => item.principal.run)), new Set(attempts.map(attempt => attempt.id)));
  for (const item of resolutions) {
    assert.equal(item.status, 200);
    assert.equal(item.principal.kind, "workspace");
    assert.equal(item.principal.workspace, `ws-${item.principal.run}`);
    assert.deepEqual(item.providers, expectedProviders);
  }
  report.resolutions = resolutions;
  report.attempts = attempts;
}

function auditPull(report, final) {
  assert.deepEqual(final.issues, report.before.issues);
  assert.equal(final.refs[report.baseRef], report.baseSha, "Pinned base stays unchanged");
  assert.equal(final.pulls.length, 1);
  const [pr] = final.pulls;
  assert.equal(pr.author, report.actors.worker.id);
  assert.equal(pr.baseRepositoryId, report.repositoryId);
  assert.equal(pr.headRepositoryId, report.repositoryId);
  assert.equal(pr.baseRef, report.baseRef);
  assert.equal(pr.baseSha, report.baseSha);
  assert.equal(pr.state, "open");
  assert.equal(pr.merged, false);
  assert.equal(pr.draft, true);
  assert.equal(pr.head, final.refs[pr.headRef]);
  assert.deepEqual(final.refs, { ...report.before.refs, [pr.headRef]: pr.head });
  assert.equal(pr.headRef, `outfitter-review-${report.settled.id}`);
  assert.equal(pr.reviews.length, 1);
  assert.equal(pr.reviews[0].state, "APPROVED");
  assert.equal(pr.reviews[0].actor, report.actors.reviewer.id);
  assert.equal(pr.reviews[0].head, pr.head, "Forgejo attributed the formal review to the immutable PR commit");
  return pr;
}

export async function exerciseInstalled(context) {
  const { box, root } = context;
  const gateway = readFileSync(join(box.env.BOX_STATE ?? "/box", "secrets", "gateway"), "utf8").trim();
  const controller = new AbortController();
  let tick;
  let interval;
  try {
    interval = setInterval(() => {
      if (tick) return;
      tick = fetch(`${root}/api/internal/workflow-schedules/tick`, { method: "POST",
        headers: { authorization: `Bearer ${gateway}`, "content-type": "application/json" }, body: "{}",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
      }).then(async response => {
        await response.body?.cancel();
        if (!response.ok) box.log(`Eval workflow tick failed (${response.status})`);
      }).catch(error => {
        if (!controller.signal.aborted) box.log(`Eval workflow tick failed (${error.message})`);
      }).finally(() => { tick = undefined; });
    }, 1_000);
    await runCase(context);
  } finally {
    clearInterval(interval);
    controller.abort();
    await tick;
  }
}

async function runCase({ box, db, auth, root, cookie, mcp, report }) {
  const pin = { repository: issue.repository, repositoryId: report.repositoryId,
    issueNumber: issue.number, baseRef: report.baseRef, baseSha: report.baseSha };
  const grant = await sessionRequest(root, cookie,
    `/api/organizations/${report.installation.organizationId}/forgejo/repositories`, "POST", {
      installationId: report.installation.id, connectionId: "box-forgejo", repository: pin.repository,
      repositoryId: pin.repositoryId, permission: "write",
    });
  assert.equal(grant.status, 200, JSON.stringify(grant));
  report.grant = grant.data;
  const providers = report.case === "provider-fenced" ? ["openai"] : ["openai", "spark"];
  const chainPath = "/o/box/api/inference/chain";
  const updated = await sessionRequest(root, cookie, chainPath, "PUT", { providers, interactiveFallback: true });
  assert.equal(updated.status, 200, JSON.stringify(updated));
  const chain = await sessionRequest(root, cookie, chainPath, "GET");
  assert.equal(chain.status, 200, JSON.stringify(chain));
  assert.deepEqual(chain.data.effective, { providers, interactiveFallback: true, source: "organization" });
  report.chain = chain.data.effective;
  report.bindings = await configure(box, db, report.installation, report.repositoryId, grant.data.connectionId);
  const runs = () => runRows(db, report.installation.id);
  assert.deepEqual(runs(), [], "Nothing has dispatched before MCP admission");
  const out = name => join(box.out, name);
  const document = report.discovered;
  const shared = document === "ReviewIssue";
  const invoke = (input = pin, scope = "box", signal) => callTool(mcp, "graph_mutate",
    { scope, app, document, variables: { input: shared ? { action: "START", provider: "FORGEJO", ...input } : input } }, signal);
  async function refuse(name, input, scope) {
    const response = await invoke(input, scope);
    assert.equal(response.refused, true, `${name} must be refused`);
    assert.ok(!response.value?.data?.reviewForgejoIssue?.run?.id);
    assert.ok(!response.value?.data?.reviewIssue?.original?.id);
    return { case: name, refused: true, result: response.text.slice(0, 300) };
  }
  async function submit() {
    const response = await invoke();
    assert.equal(response.refused, false, response.text);
    const result = response.value?.data?.[shared ? "reviewIssue" : "reviewForgejoIssue"];
    if (shared) assert.equal(result?.provider, "FORGEJO");
    const receipt = shared ? { ...result, run: { ...result?.original, workflow: workflowId } } : result;
    assert.ok(receipt?.run?.id, "Installed mutation returns a run ID");
    assert.equal(receipt.run.workflow, workflowId);
    assert.deepEqual(receipt.target, pin);
    return receipt;
  }
  const provider = () => inventory(auth.admin);
  const settle = id => waitFor(() => runs().find(row =>
    row.id === id && terminal(row.status)), "workflow settlement",
    ["draft-read-refusal", "race-lost", "review-not-sent", "authority-retry", "recovery-lost"].includes(report.case) ? 270_000 : 150_000);
  if (report.case === "refusal") {
    report.refusals = [];
    for (const [name, input, scope] of [
      ["wrong-tenant", pin, "unrelated-tenant"],
      ["wrong-forgejo-owner", { ...pin, repository: "wrong-org/review-fixture" }],
      ["wrong-repository-id", { ...pin, repositoryId: 9999 }],
      ["missing-issue", { ...pin, issueNumber: issue.number + 100 }],
      ["missing-base-ref", { ...pin, baseRef: "missing" }],
      ["wrong-base-sha", { ...pin, baseSha: "f".repeat(40) }],
    ]) report.refusals.push(await refuse(name, input, scope));
    assert.deepEqual(runs(), []);
    report.final = await provider();
    assert.deepEqual(report.final, report.before);
    assert.ok(!existsSync(out("provider.jsonl")), "Admission refusals dispatch zero model calls");
    return;
  }

  writeFileSync(out("provider-context.json"), JSON.stringify({ database: box.databases.platform,
    installationId: report.installation.id, workflowId, pin }));
  if (report.case.startsWith("recovery-")) {
    await exerciseRecovery({ box, db, auth, mcp, report, pin, workflowId, out, runs, settle, auditPull, gradeResolution });
    return;
  }
  if (report.case === "mixed-gateway") {
    const receipt = await submit();
    report.settled = await settle(receipt.run.id);
    assert.equal(report.settled.status, "failed");
    assert.ok(sameRun(runs(), receipt.run.id));
    const attempts = db.prepare("SELECT id, nodeId, state FROM workflow_node_attempts WHERE runId=?").all(receipt.run.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].nodeId, "implement");
    assert.equal(attempts[0].state, "failed");
    const gateway = new DatabaseSync(box.databases.gateway, { readOnly: true });
    try {
      const workspace = gateway.prepare("SELECT id, namespace, token FROM workspaces WHERE id=?").get(`ws-${attempts[0].id}`);
      assert.ok(workspace, "The legacy gateway started the new runtime");
      const directory = join(box.workspaces, workspace.namespace, workspace.id);
      const config = JSON.parse(readFileSync(join(directory, ".outfitter", "pi", "models.json"), "utf8"));
      const baseUrl = `http://127.0.0.1:4040/pinned-inference/${workspace.id}/v1`;
      assert.equal(config.providers.workspace.baseUrl, baseUrl);
      const checkout = execFileSync("git", ["-C", join(directory, "files", "repo"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      assert.equal(checkout, pin.baseSha, "Native prefetch succeeded before the runtime attempted inference");
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${workspace.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Synthetic route probe" }] }),
      });
      assert.equal(response.status, 401, "The legacy gateway falls through to gateway-only authentication");
      assert.deepEqual(await response.json(), { error: "Unauthorized" });
      const sourceSha256 = createHash("sha256").update(readFileSync("/app/workspace/gateway.mjs")).digest("hex");
      assert.equal(sourceSha256, "ef07cab796bd9ce50b92d6661fba385997c64f1518df67b3e2c760b26feb4d92");
      report.mixedGateway = { sourceSha256, pinnedInferenceUrl: baseUrl, status: response.status, checkout };
    } finally {
      gateway.close();
    }
    assert.ok(!existsSync(out("provider.jsonl")));
    assert.ok(!existsSync(out("resolution.jsonl")), "Legacy gateway refused before owner resolution");
    report.final = await provider();
    assert.deepEqual(report.final, report.before);
    return;
  }
  if (report.case === "provider-fenced") {
    const receipt = await submit();
    report.settled = await settle(receipt.run.id);
    assert.equal(report.settled.status, "failed");
    assert.ok(sameRun(runs(), receipt.run.id));
    report.final = await provider();
    assert.deepEqual(report.final, report.before);
    assert.ok(!existsSync(out("provider.jsonl")));
    gradeResolution(db, out, report, receipt.run.id, ["openai"], ["implement"]);
    return;
  }
  if (report.case === "race-lost") {
    writeFileSync(out("drop-publication-responses"), "");
    writeFileSync(out("forgejo-hold-before.json"), JSON.stringify({
      path: `/api/v1/repos/${issue.repository}/branches/main`,
    }));
  }
  if (["before-work", "before-open", "before-review", "before-review-base"].includes(report.case)) {
    const caseName = report.case;
    const reviewing = caseName.startsWith("before-review");
    if (!reviewing) {
      writeFileSync(out("forgejo-hold-before.json"), JSON.stringify({
        path: `/api/v1/repos/${issue.repository}/branches/main`, requireRun: true,
        requireCommit: caseName === "before-open",
      }));
    } else {
      writeFileSync(out("model-hold"), "review");
    }

    const ledger = () => readFileSync(out("forgejo-requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const baseReads = () => ledger().filter(entry => entry.method === "GET" && entry.status === 200
      && entry.path === `/api/v1/repos/${issue.repository}/branches/main`).length;
    let readsBeforeRelease;
    const started = submit();
    // Hold the rejection until the fixture has released any in-flight provider call.
    void started.catch(() => {});
    try {
      await waitFor(() => existsSync(out(reviewing ? "model-held.json" : "forgejo-held-before")),
        `${caseName} barrier`, caseName === "before-work" ? 40_000 : 120_000);
      const atBarrier = await provider();
      assert.equal(atBarrier.refs.main, pin.baseSha);
      assert.equal(atBarrier.pulls.length, reviewing ? 1 : 0);
      let ref = "main";
      if (caseName === "before-open") {
        assert.equal(Object.keys(atBarrier.refs).length, 2, "A candidate commit exists before the final base check");
        assert.ok(Object.entries(atBarrier.refs).some(([branch, head]) => branch !== "main" && head !== pin.baseSha));
      }
      if (reviewing) {
        const [pr] = atBarrier.pulls;
        assert.deepEqual(pr.reviews, []);
        const checkpoint = JSON.parse(readFileSync(out("model-held.json"), "utf8"));
        assert.equal(checkpoint.checkout, pr.head);
        if (caseName === "before-review") ref = pr.headRef;
      }
      const movedSha = pushFixtureCommit(auth.admin, ref, ref, moved);
      assert.notEqual(movedSha, atBarrier.refs[ref]);
      report.move = { case: caseName, before: atBarrier, ref, oldSha: atBarrier.refs[ref], movedSha };
      readsBeforeRelease = baseReads();
    } finally {
      writeFileSync(out("forgejo-release-before"), "");
      writeFileSync(out("model-release"), "");
    }
    const receipt = await started;
    if (caseName === "before-work") {
      report.observedRun = await waitFor(() => {
        const current = runs().find(row => row.id === receipt.run.id);
        return current && (terminal(current.status) || baseReads() >= readsBeforeRelease + 2) ? current : undefined;
      }, "terminal refusal or two source rechecks against the moved base");
      assert.notEqual(report.observedRun.status, "complete");
      report.baseRechecksAfterMove = baseReads() - readsBeforeRelease;
      assert.ok(report.baseRechecksAfterMove >= 1);
    } else {
      report.settled = await settle(receipt.run.id);
      assert.notEqual(report.settled.status, "complete");
    }
    assert.ok(sameRun(runs(), receipt.run.id));
    report.final = await provider();
    assert.deepEqual(report.final.issues, report.before.issues);
    assert.equal(report.final.refs[report.move.ref], report.move.movedSha);
    assert.equal(report.final.pulls.length, reviewing ? 1 : 0);
    if (caseName === "before-work") {
      assert.deepEqual(report.final.refs, { main: report.move.movedSha });
      assert.ok(!existsSync(out("provider.jsonl")), "No work model was invoked after base drift");
    }
    if (reviewing) {
      assert.equal(report.final.pulls[0].state, "open");
      assert.equal(report.final.pulls[0].draft, true);
      assert.equal(report.final.pulls[0].merged, false);
      assert.deepEqual(report.final.pulls[0].reviews, []);
    }
    const requests = ledger();
    assert.equal(requests.filter(entry => entry.method === "POST" && /\/api\/v1.*\/pulls$/.test(entry.path)).length, reviewing ? 1 : 0);
    assert.equal(requests.filter(entry => entry.method === "POST" && /\/pulls\/\d+\/reviews$/.test(entry.path)).length, 0);
    return;
  }

  assert.ok(["happy", "race-lost", "slash-base", "draft-read-refusal", "review-not-sent", "authority-retry"].includes(report.case), `Unknown installed case ${report.case}`);
  const first = submit();
  void first.catch(() => {});
  const receipts = [];
  if (report.case === "race-lost") {
    try {
      await waitFor(() => existsSync(out("forgejo-held-before")), "first MCP contender's native source read");
      assert.deepEqual(runs(), [], "First contender is still in admission");
      receipts.push(...await Promise.all(Array.from({ length: 4 }, submit)));
    } finally {
      writeFileSync(out("forgejo-release-before"), "");
      await first;
    }
  }
  receipts.push(await first);
  const id = receipts[0].run.id;
  assert.deepEqual(new Set(receipts.map(item => item.run.id)), new Set([id]));
  report.concurrentReceipts = receipts.map(item => item.run);
  report.settled = await settle(id);
  assert.equal(report.settled.status, "complete");
  assert.ok(sameRun(runs(), id));
  const replay = await submit();
  assert.equal(replay.run.id, id);
  report.replay = replay;
  const conflictingPin = report.case === "slash-base" ? { baseRef: "main" } : { baseSha: "f".repeat(40) };
  report.conflictingReplay = await refuse("conflicting-pins", { ...pin, ...conflictingPin });
  report.final = await provider();
  const pr = auditPull(report, report.final);
  report.git = inspectCandidate(auth.admin, pin.baseSha, pr.head, pr.headRef);
  assert.deepEqual(report.git, { head: pr.head, parents: [pin.baseSha], files: ["README.md"],
    readme: "# Synthetic lamp\n\nSetting: amber." });
  const modelEvents = readFileSync(out("provider.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(modelEvents.filter(event => event.event === "error"), []);
  const completions = modelEvents.filter(event => event.event === "response");
  assert.deepEqual(completions.map(event => [event.actor, event.runId, event.checkout]),
    [["implement", id, pin.baseSha], ["review", id, pr.head]]);
  report.provider = completions;
  gradeResolution(db, out, report, id, ["openai", "spark"], ["implement", "review"]);
  const usage = readFileSync(out("box.log"), "utf8").split("\n")
    .filter(line => line.startsWith('{"event":"inference_usage"')).map(JSON.parse);
  assert.equal(usage.length, 4, "One checkout probe and one output per workspace");
  assert.ok(usage.every(item => item.provider === "spark" && item.model === model && item.status === 200));
  assert.deepEqual(new Set(usage.map(item => item.run)), new Set(report.attempts.map(attempt => attempt.id)));
  report.gatewayInference = usage.map(({ provider, model, run, promptTokens, completionTokens }) =>
    ({ provider, model, run, promptTokens, completionTokens }));
  const content = readFileSync(out("forgejo-requests.jsonl"), "utf8");
  const requests = content.trim().split("\n").map(JSON.parse);
  const creates = requests.filter(event =>
    event.path === `/api/v1/repos/${issue.repository}/pulls` && event.method === "POST");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].status, 201);
  const publications = requests.filter(event => event.method === "POST" && /\/pulls\/\d+\/reviews$/.test(event.path));
  assert.equal(publications.length, 1);
  assert.equal(Boolean(publications[0].dropped), report.case === "race-lost");
  if (existsSync("/app/src/pages/api/internal/workspace-review-authority.ts")) {
    const callbacks = readFileSync(out("review-authority.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const valid = callbacks.filter(event => !event.staleBinding);
    const stale = callbacks.filter(event => event.staleBinding);
    assert.ok(valid.length > 0);
    assert.ok(valid.every(event => event.status === 204));
    assert.equal(valid[0].reviewPosts, 0);
    assert.ok(callbacks.every(event => event.authenticated && event.runId === id &&
      event.attemptId === report.attempts.find(attempt => attempt.nodeId === "review").id &&
      event.repository === pin.repository && event.repositoryId === pin.repositoryId));
    if (report.case === "authority-retry") {
      assert.equal(stale.length, 1);
      assert.equal(callbacks[0], stale[0]);
      assert.equal(stale[0].status, 403);
      assert.equal(stale[0].reviewPosts, 0);
      assert.match(readFileSync(out("box.log"), "utf8"), /reason: 'Forgejo write was not sent; retrying its frozen claim'/);
    } else {
      assert.deepEqual(stale, []);
    }
    report.reviewAuthority = callbacks;
  }
  if (report.case === "review-not-sent") {
    const preflights = requests.filter(event => event.injected === "reviewer-preflight-refusal");
    assert.equal(preflights.length, 1);
    const refusal = requests.indexOf(preflights[0]);
    const sent = requests.indexOf(publications[0]);
    assert.ok(refusal < sent);
    assert.ok(requests.slice(refusal + 1, sent)
      .some(event => event.method === "GET" && event.path === preflights[0].path && event.status === 200));
    assert.match(readFileSync(out("box.log"), "utf8"), /reason: 'Forgejo write was not sent; retrying its frozen claim'/);
    report.noEffectRetry = { refusal: preflights[0], nativeReviewPosts: publications.length };
  }
  for (const resource of ["branches", "contents"]) {
    const writes = requests.filter(event => event.method === "POST" && event.path === `/api/v1/repos/${issue.repository}/${resource}`);
    assert.equal(writes.length, 1);
    assert.ok(writes[0].status >= 200 && writes[0].status < 300);
    assert.equal(Boolean(writes[0].dropped), report.case === "race-lost");
  }
  assert.equal(requests.filter(event => event.method === "POST" && event.path.endsWith("/git-receive-pack")).length, 1,
    "The only Git push was fixture import. Actor changes went through the coordinator.");
  assert.equal(Boolean(creates[0].dropped), ["race-lost", "draft-read-refusal"].includes(report.case));
  if (report.case === "draft-read-refusal") {
    const refusal = requests.filter(event => event.injected === "generic-draft-read-refusal");
    assert.equal(refusal.length, 1);
    assert.equal(refusal[0].status, 403);
    const after = requests.slice(requests.indexOf(refusal[0]) + 1);
    assert.ok(after.some(event => event.method === "GET" && event.path === refusal[0].path && event.status === 200),
      "A later read reconciles the already-created draft");
    report.transientDraftRefusal = refusal[0];
  }
  assert.ok(replay.candidate && replay.review, "Settled replay exposes candidate and review receipts");
  assert.deepEqual({
    number: replay.candidate.number, head: replay.candidate.headSha, ref: replay.candidate.branch,
    author: replay.candidate.authorId,
  }, { number: pr.number, head: pr.head, ref: pr.headRef, author: pr.author });
  assert.equal(new URL(replay.candidate.url).origin, "http://127.0.0.1:3300");
  assert.equal(new URL(replay.review.url).origin, "http://127.0.0.1:3300");
  const [formal] = pr.reviews;
  assert.deepEqual({ id: replay.review.id, head: replay.review.headSha, actor: replay.review.reviewer.id,
    verdict: replay.review.verdict }, { id: formal.id, head: formal.head, actor: formal.actor, verdict: "approved" });
}

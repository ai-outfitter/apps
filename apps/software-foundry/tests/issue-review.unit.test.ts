import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { prepareResult, type PhaseInput, type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { documents } from "../src/server/documents";
import type { IntakeContext } from "../src/server/intake";
import {
  configureIssueReview, finalizeIssueReview, issueReviewWorkflow, prepareIssueReview, readIssueReview,
  recoverIssueReview, reviewForgejoIssue, reviewIssuePins, reviewIssueInput,
} from "../src/server/workspace/issue-review";

const pin = { repository: "fixtures/rules", repositoryId: 45, issueNumber: 4, baseRef: "milestones/review", baseSha: "a".repeat(40) };
const commit = "b".repeat(40);
const baseBlob = "c".repeat(40);
const untouchedBlob = "1".repeat(40);
const baseContent = "Original æ\n";
const updatedBlob = "d".repeat(40);
const baseTree = "e".repeat(40);
const headTree = "f".repeat(40);
const origin = "https://forge.example";
const draftUrl = `${origin}/${pin.repository}/pulls/8`;
const repo = { name: pin.repository, repositoryId: pin.repositoryId, forge: "forgejo", appId: 21,
  path: `/repos/${pin.repository}`, installationId: 1, checkout: "forgejo-pinned", inferenceProvider: "spark", connectionId: "connection" };

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL("../migrations/0010_foundry_forgejo_issue_reviews.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0011_foundry_forgejo_commit_proof.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0012_foundry_forgejo_review_selection.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0013_foundry_forgejo_dispatch.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0014_foundry_forgejo_issue_recovery.sql", import.meta.url), "utf8"));
  const key = createHash("sha256").update(JSON.stringify(["installation", origin, pin.repositoryId])).digest("hex");
  sqlite.prepare(`INSERT INTO foundry_forgejo_issue_review_bindings
    (key, revision, connectionId, implementer, reviewer, reviewerName, reviewerId, workerId)
    VALUES (?, 'initial', 'connection', 'implementer', 'reviewer', 'reviewer', 23, 21)`).run(key);
  const db = () => drizzle(async (sql, params, method) => {
    const statement = sqlite.prepare(sql);
    statement.setReturnArrays(true);
    if (method === "run") { statement.run(...params); return { rows: [] }; }
    const rows = statement.all(...params);
    return { rows: method === "get" ? rows[0] as unknown as unknown[] : rows };
  });

  const calls: { operation: string; path?: string; method?: string }[] = [];
  const state = {
    granted: true, baseSha: pin.baseSha, repoId: pin.repositoryId, reviewer: 23, issueOpen: true,
    baseError: 0, writer: repo.appId, committer: repo.appId, provider: origin, connectionId: "connection",
    extraPath: false, splitTree: false, providerContent: "Updated æ\n",
    loseStart: false, loseWrites: false, missingCommit: false, moveAfterPull: false,
    head: null as string | null, branch: "", message: "", runId: "", inputs: {} as Record<string, any>,
    pull: null as Record<string, any> | null, reviews: [] as Record<string, any>[], reviewAttempt: "", reviewWrites: 0,
  };
  const bindings = new Map<string, string>([["implementer", "implementer"], ["reviewer", "reviewer"]]);
  let intercept: ((operation: string, input: Record<string, any>) => Promise<void> | void) | undefined;
  const runs = new Map<string, Record<string, unknown>>();
  const failedRuns = new Map<string, Record<string, unknown>[]>();
  const author = () => ({ id: state.reviewer, login: "independent" });
  const missing = () => new Response("Missing", { status: 404 });
  const lost = () => new Response("Receipt unavailable", { status: 502 });
  const host = {
    async call(operation: string, input: Record<string, any>) {
      calls.push({ operation, path: input.path, method: input.method });
      await intercept?.(operation, input);
      switch (operation) {
        case "snapshot":
          return { installation: { id: "installation", workflows: [issueReviewWorkflow] },
            bindings: Array.from(bindings, ([id, role]) => ({
              id, actor: role, enabled: true, kind: "external", workflowId: issueReviewWorkflow, label: role,
            })),
            connections: [{ id: state.connectionId, provider: "forgejo", owner: "organization",
              operations: ["issues.read"], repositories: state.granted ? [pin.repository] : [] }] };
        case "binding.approve": {
          assert.equal(input.workspace.checkout, "forgejo-pinned");
          assert.equal(input.workspace.connectionId, state.connectionId);
          assert.equal(input.workspace.inferenceProvider, "spark");
          assert.deepEqual(input.workspace.agentPermissions, { contents: "read", pull_requests: "read", issues: "read" });
          assert.equal(input.workspace.coordinatorPermissions.issues, "read");
          assert.equal(input.workspace.coordinatorPermissions.pull_requests, input.actor === "implementer" ? "write" : "read");
          const isDefault = input.actor === "implementer" ? input.context.model === "worker" : input.context.model === "review-model";
          const id = isDefault ? input.actor : `${input.actor}-${input.context.model}`;
          bindings.set(id, input.actor);
          return { id };
        }
        case "repository.read":
          assert.ok(bindings.has(input.bindingId));
          return { ...repo, repositoryId: state.repoId, connectionId: state.connectionId };
        case "workflow.read":
          return runs.has(input.id) ? {
            run: { id: input.id, createdBy: "editor", workflowId: issueReviewWorkflow,
              status: failedRuns.has(input.id) ? "failed" : "running" },
            inputs: runs.get(input.id), outputs: {}, attempts: failedRuns.get(input.id) ?? [],
          } : null;
        case "workflow.start": {
          const created = !runs.has(input.id);
          if (created) {
            state.runId = input.id;
            state.inputs = input.inputs;
            runs.set(input.id, input.inputs);
          } else assert.deepEqual(input.inputs, runs.get(input.id));
          if (state.loseStart && created) throw lost();
          return { id: input.id, workflow: input.workflow, created };
        }
        case "workspace.control":
          if (input.operation === "inspect-reviewer") return author();
          assert.equal(input.operation, "publish-review");
          state.reviewWrites++;
          assert.equal(input.expectedReviewerId, 23);
          assert.equal(input.candidate.headSha, commit);
          state.reviews.push({ id: 60, html_url: `${draftUrl}#review-60`, user: author(), state: "APPROVED", commit_id: commit,
            body: `<!-- outfitter:workspace-review:${state.reviewAttempt} -->` });
          if (state.loseWrites) throw lost();
          return { id: 60, url: `${draftUrl}#review-60`, headSha: commit, verdict: "approved", reviewer: author() };
        case "repository.request": {
          const path = input.path.slice(repo.path.length);
          if (input.method === "POST") {
            if (path === "/branches") {
              assert.equal(input.body.old_ref_name, pin.baseSha);
              state.branch = input.body.new_branch_name;
              state.head = pin.baseSha;
            } else if (path === "/contents") {
              assert.equal(input.body.branch, state.branch);
              assert.equal(input.body.files.length, 1);
              assert.equal(input.body.files[0].operation, "update");
              assert.equal(input.body.files[0].sha, baseBlob);
              assert.equal(Buffer.from(input.body.files[0].content, "base64").toString("utf8"), "Updated æ\n");
              state.message = input.body.message;
              if (!state.missingCommit) {
                state.head = commit;
                if (!state.loseWrites) return { commit: { sha: commit } };
              }
            } else {
              assert.equal(path, "/pulls");
              assert.equal(input.body.head, state.branch);
              assert.equal(input.body.base, pin.baseRef);
              assert.doesNotMatch(input.body.body, /closes|fixes|resolves/i);
              const ref = (name: string, sha: string) => ({ ref: name, sha, repo: { id: pin.repositoryId, full_name: pin.repository } });
              state.pull = { number: 8, html_url: draftUrl, title: input.body.title, body: input.body.body, state: "open", merged: false,
                user: { id: 21 }, base: ref(pin.baseRef, state.baseSha), head: ref(state.branch, commit) };
              if (state.moveAfterPull) state.baseSha = "d".repeat(40);
              if (!state.loseWrites) return state.pull;
            }
            if (state.loseWrites) throw lost();
            return {};
          }
          if (path === "") return { id: state.repoId, full_name: pin.repository, html_url: `${state.provider}/${pin.repository}` };
          if (/^\/issues\/\d+$/.test(path)) return { state: state.issueOpen ? "open" : "closed",
            number: Number(path.split("/").at(-1)), title: "Fix an example", html_url: `${state.provider}/${pin.repository}${path}` };
          if (path === `/branches/${pin.baseRef}`) {
            if (state.baseError) throw new Response("Provider lookup unavailable", { status: state.baseError });
            return { name: pin.baseRef, commit: { id: state.baseSha } };
          }
          if (path.startsWith("/git/commits/")) {
            const isBase = path.includes(pin.baseSha);
            return { sha: isBase ? pin.baseSha : commit, commit: { message: state.message, tree: { sha: isBase ? baseTree : headTree } },
              parents: isBase ? [] : [{ sha: pin.baseSha }], author: { id: state.writer }, committer: { id: state.committer } };
          }
          if (path.startsWith("/git/trees/")) {
            const isBase = path.includes(baseTree);
            const tree = [{ path: "example.md", type: "blob", mode: "100644", sha: isBase ? baseBlob : updatedBlob }];
            if (state.splitTree) tree.push({ path: "untouched.md", type: "blob", mode: "100644", sha: untouchedBlob });
            if (!isBase && state.extraPath) tree.push({ path: "unassigned.md", type: "blob", mode: "100644", sha: "2".repeat(40) });
            const page = Number(new URL(path, origin).searchParams.get("page"));
            return { sha: isBase ? baseTree : headTree, tree: state.splitTree ? tree.slice(page - 1, page) : tree,
              total_count: tree.length, truncated: state.splitTree };
          }
          if (path === `/git/blobs/${baseBlob}` || path === `/git/blobs/${untouchedBlob}`)
            return { sha: path.split("/").at(-1), encoding: "base64", content: Buffer.from(baseContent).toString("base64") + "\n" };
          if (path === `/git/blobs/${updatedBlob}`)
            return { sha: updatedBlob, encoding: "base64", content: Buffer.from(state.providerContent).toString("base64") };
          if (path.startsWith("/branches/")) {
            if (!state.head || path !== `/branches/${state.branch}`) throw missing();
            return { name: state.branch, commit: { id: state.head } };
          }
          if (path === `/contents/example.md?ref=${pin.baseSha}`) return { type: "file", sha: baseBlob };
          if (path === `/contents/untouched.md?ref=${pin.baseSha}`) return { type: "file", sha: untouchedBlob };
          if (path.startsWith("/pulls?state=all")) return state.pull ? [state.pull] : [];
          if (path === "/pulls/8") return state.pull;
          if (path === "/pulls/8/reviews?limit=50") return state.reviews;
          throw new Error(`Unexpected repo read: ${path}`);
        }
        default: throw new Error(`Unexpected operation: ${operation}`);
      }
    },
  };
  const context = { host: () => host, db, identity: { kind: "organization", organizationId: "org", installationId: "installation",
    userId: "editor", role: "admin" } } as unknown as IntakeContext;
  function phase(nodeId: "implement" | "review", coordinator = false) {
    const attemptId = crypto.randomUUID();
    if (nodeId === "review") state.reviewAttempt = attemptId;
    const result: PhaseInput = nodeId === "implement" ? { summary: "Checked fixture", files: [{ path: "example.md", content: "Updated æ\n" }] }
      : { headSha: commit, verdict: "approved", summary: "Review independently checked the fixture" };
    const settings: PhaseInput = { policy: issueReviewWorkflow, role: nodeId + "er", reviewer: "reviewer" };
    return { node: { runId: state.runId, nodeId, attemptId }, settings,
      inputs: { target: state.inputs["implement.inputs.target"] }, outputs: { result }, coordinator, session: {} };
  }
  return {
    state, calls, context, db, phase,
    failedRuns,
    intercept: (callback: typeof intercept) => { intercept = callback; },
    claim: () => sqlite.prepare("SELECT branchClaim, commitClaim, commitProof FROM foundry_forgejo_issue_reviews WHERE runId=?").get(state.runId),
    selection: () => sqlite.prepare("SELECT implementer, reviewer FROM foundry_forgejo_issue_review_bindings WHERE key=?").get(key),
    prepare: (input: ReturnType<typeof phase>) => prepareIssueReview(host as unknown as WorkflowHost<"prepare">, db, input),
    finalize: (input: ReturnType<typeof phase>) => finalizeIssueReview(host as unknown as WorkflowHost<"finalize">, db, input),
    configure: (implementerModel = "worker", reviewerModel = "review-model") =>
      configureIssueReview(host as unknown as WorkflowHost<"operator">, db, { operation: "configure-issue-review",
        repository: pin.repository, repositoryId: pin.repositoryId, reviewer: "reviewer", implementerModel, reviewerModel }),
    start: (input = pin) => reviewForgejoIssue(context, input),
    writes: () => calls.filter(call => call.method === "POST").map(call => call.path),
  };
}

const refused = (status: number) => (error: unknown) => error instanceof Response && error.status === status;

test("both providers use the same review command and recovery accepts only an original run ID", () => {
  for (const provider of ["GITHUB", "FORGEJO"]) {
    assert.equal(reviewIssueInput.safeParse({ input: { action: "START", provider, ...pin } }).success, true);
    assert.equal(reviewIssueInput.safeParse({ input: { action: "START", provider, ...pin, runId: crypto.randomUUID() } }).success, false);
  }
  const recovery = { action: "RECOVER", runId: crypto.randomUUID() };
  assert.equal(reviewIssueInput.safeParse({ input: recovery }).success, true);
  assert.equal(reviewIssueInput.safeParse({ input: { ...recovery, provider: "GITHUB" } }).success, false);
  assert.equal(reviewIssueInput.safeParse({ input: { ...recovery, baseSha: pin.baseSha } }).success, false);
});

test("recovers one retained initialization failure after a lost start receipt without clearing history", async t => {
  const f = fixture(t);
  const admitted = await f.start();
  const { id } = admitted.run;
  const attempt = { id: crypto.randomUUID(), nodeId: "implement", state: "failed",
    failure: "Pinned checkout could not initialize.", sessionArtifact: { id: crypto.randomUUID(), runId: id } };
  f.failedRuns.set(id, [attempt]);
  assert.equal((await readIssueReview(f.context, id)).recovery, null);
  f.state.granted = false;
  await assert.rejects(recoverIssueReview(f.context, id), refused(403));
  f.state.granted = true;
  f.state.loseStart = true;
  await assert.rejects(recoverIssueReview(f.context, id), refused(502));
  const recovered = await readIssueReview(f.context, id);
  assert.deepEqual(recovered.original, { id, status: "failed", attempts: [attempt] });
  assert.equal(recovered.recovery?.status, "running");
  assert.notEqual(recovered.recovery?.id, id);
  assert.deepEqual(recovered.target, admitted.target);
  f.state.granted = false;
  assert.deepEqual(await Promise.all(Array.from({ length: 3 }, () => recoverIssueReview(f.context, id))),
    [recovered, recovered, recovered]);
  assert.deepEqual(f.writes(), []);
});

test("refuses recovery without checkout failure proof or when source and native observations disagree", async t => {
  const f = fixture(t);
  const { run: { id } } = await f.start();
  const attempt = { id: crypto.randomUUID(), nodeId: "implement", state: "failed",
    failure: "Pinned checkout could not initialize.", sessionArtifact: { id: crypto.randomUUID(), runId: id } };
  const recover = () => recoverIssueReview(f.context, id);
  f.failedRuns.set(id, [{ ...attempt, failure: "Workspace execution failed" }]);
  await assert.rejects(recover(), refused(409));
  f.failedRuns.set(id, [attempt]);
  f.state.baseSha = commit;
  await assert.rejects(recover(), refused(409));
  f.state.baseSha = pin.baseSha;
  f.state.branch = (f.state.inputs["implement.inputs.target"] as { branch: string }).branch;
  f.state.head = pin.baseSha;
  await assert.rejects(recover(), refused(409));
  f.state.head = null;
  f.state.pull = { head: { ref: f.state.branch, repo: null }, body: null };
  await assert.rejects(recover(), refused(409));
  assert.equal((await readIssueReview(f.context, id)).recovery, null);
  assert.equal(f.calls.filter(call => call.operation === "workflow.start").length, 1);
  assert.deepEqual(f.writes(), []);
});

test("publishes the authenticated document and approves only its two pinned roles", async t => {
  assert.match(JSON.stringify(documents), /ReviewForgejoIssue/);
  assert.equal(reviewIssuePins.safeParse({ ...pin, baseRef: "refs/heads/main" }).success, false);
  const f = fixture(t);
  assert.deepEqual(await f.configure(), { workflow: issueReviewWorkflow, repository: pin.repository,
    implementer: "implementer", reviewer: "reviewer" });
  assert.deepEqual(f.writes(), []);
});

test("rejects missing grant, source drift, a closed issue, and a shared actor before starting", async t => {
  const f = fixture(t);
  for (const [key, value, status] of [
    ["granted", false, 403], ["repoId", 46, 409], ["baseSha", commit, 409], ["issueOpen", false, 409], ["reviewer", 21, 403],
  ] as const) {
    const original = { ...f.state };
    Object.assign(f.state, { [key]: value });
    await assert.rejects(f.start(), refused(status));
    Object.assign(f.state, original);
  }
  assert.equal(f.state.runId, "");
  assert.deepEqual(f.writes(), []);
});

test("converges concurrent starts and lost provider replies on one preserved branch, draft and review", async t => {
  const f = fixture(t);
  f.state.loseStart = true;
  const starts = await Promise.allSettled([f.start(), f.start()]);
  assert.ok(starts.some(attempt => attempt.status === "rejected"));
  const retry = await f.start();
  assert.equal(retry.run.id, f.state.runId);
  assert.equal(retry.run.existing, true);
  await assert.rejects(f.start({ ...pin, baseSha: commit }), refused(409));

  f.state.loseWrites = true;
  const implement = f.phase("implement");
  assert.deepEqual(prepareResult.parse(await f.prepare(implement)).mode, "agent");
  assert.deepEqual((await f.prepare(implement)), {
    mode: "agent", role: "implement", checkout: { sha: pin.baseSha },
    guidance: [
      `Work in the local repo checkout from ${pin.baseRef} at ${pin.baseSha}. Check that exact revision before editing.`,
      "Propose complete text for added or updated files, with your check summary. This workflow supports no deletions or renames.",
    ],
  });
  await f.finalize(implement);
  await f.finalize(f.phase("implement", true));

  const review = f.phase("review");
  const prepared = await f.prepare(review);
  assert.equal(prepared.mode, "agent");
  if (prepared.mode === "agent") assert.deepEqual(prepared.checkout, { sha: commit, baseSha: pin.baseSha });
  await f.finalize(review);
  await f.finalize(f.phase("review", true));
  const final = await f.start();
  assert.deepEqual(final.candidate, { number: 8, url: draftUrl, authorId: 21, headSha: commit, branch: f.state.branch });
  assert.equal(final.review?.id, 60);
  assert.equal(f.state.reviews.length, 1);
  assert.deepEqual(f.writes(), [`${repo.path}/branches`, `${repo.path}/contents`, `${repo.path}/pulls`]);
});

test("refuses post-admission base drift, stale PR heads and changed reviewer identity", async t => {
  const f = fixture(t);
  await f.start();
  const implement = f.phase("implement");
  f.state.baseSha = commit;
  await assert.rejects(f.prepare(implement), refused(422));
  await assert.rejects(f.finalize(implement), refused(422));
  assert.deepEqual(f.writes(), []);
  f.state.baseSha = pin.baseSha;
  await f.finalize(implement);
  const review = f.phase("review");
  await assert.rejects(f.prepare({ ...review, settings: { role: "review" } }), refused(403));
  f.state.pull!.head.sha = "d".repeat(40);
  await assert.rejects(f.prepare(review), refused(422));
  f.state.pull!.head.sha = commit;
  f.state.reviewer = 99;
  await assert.rejects(f.finalize(review), refused(422));
  assert.equal(f.state.reviews.length, 0);
});

test("never retries an unseen commit or reports a draft after the base moves during creation", async t => {
  const f = fixture(t);
  await f.start();
  f.state.missingCommit = true;
  await assert.rejects(f.finalize(f.phase("implement")), refused(503));
  await assert.rejects(f.finalize(f.phase("implement", true)), refused(503));
  assert.deepEqual(f.writes(), [`${repo.path}/branches`, `${repo.path}/contents`]);

  const afterPull = fixture(t);
  await afterPull.start();
  afterPull.state.moveAfterPull = true;
  await assert.rejects(afterPull.finalize(afterPull.phase("implement")), refused(422));
  const receipt = await afterPull.start();
  assert.equal(receipt.candidate, null);
  assert.equal(receipt.draftObservation?.status, "blocked");
  assert.equal(receipt.draftObservation?.url, draftUrl);
  assert.equal(receipt.draftObservation?.number, 8);
  assert.equal(receipt.draftObservation?.expectedBaseSha, pin.baseSha);
  await assert.rejects(afterPull.finalize(afterPull.phase("implement", true)), refused(422));
  assert.equal(afterPull.writes().length, 3);
});

test("transient phase lookup failures can retry while a verified connection pin mismatch is terminal", async t => {
  const f = fixture(t);
  await f.start();
  const implement = f.phase("implement");
  for (const status of [409, 429, 503]) {
    f.state.baseError = status;
    await assert.rejects(f.prepare(implement), refused(status));
  }
  f.state.baseError = 0;
  assert.equal((await f.prepare(implement)).mode, "agent");
  f.state.connectionId = "replacement";
  await assert.rejects(f.prepare(implement), refused(422));
  await assert.rejects(f.start(), refused(403));
  assert.deepEqual(f.writes(), []);
});

test("recovery rejects a same-marker same-parent commit with different bytes, extra paths, or wrong attribution", async t => {
  for (const altered of [
    { providerContent: "different bytes\n" }, { extraPath: true }, { writer: 99 }, { committer: 99 },
  ]) {
    const f = fixture(t);
    await f.start();
    f.state.loseWrites = true;
    f.state.missingCommit = true;
    await assert.rejects(f.finalize(f.phase("implement")), refused(503));
    assert.ok(f.state.message.includes(f.state.runId));
    Object.assign(f.state, altered, { head: commit });
    await assert.rejects(f.finalize(f.phase("implement", true)), refused(422));
    assert.deepEqual(f.writes(), [`${repo.path}/branches`, `${repo.path}/contents`]);
  }
});

test("recovers the frozen file proof on a later read after an uncertain write", async t => {
  const f = fixture(t);
  await f.start();
  f.state.loseWrites = true;
  f.state.missingCommit = true;
  await assert.rejects(f.finalize(f.phase("implement")), refused(503));
  f.state.head = commit;
  f.state.splitTree = true;
  await f.finalize(f.phase("implement", true));
  assert.equal((await f.start()).candidate?.headSha, commit);
  assert.deepEqual(f.writes(), [`${repo.path}/branches`, `${repo.path}/contents`, `${repo.path}/pulls`]);
});


test("private Forgejo origins with the same numeric IDs produce distinct stable runs", async t => {
  const f = fixture(t);
  const first = await f.start();
  Object.assign(f.state, { provider: "https://another-forge.example", connectionId: "another-connection" });
  await f.configure();
  const second = await f.start();
  assert.notEqual(second.run.id, first.run.id);
  assert.equal((await f.start()).run.id, second.run.id);
  Object.assign(f.state, { provider: origin, connectionId: "connection" });
  assert.equal((await f.start()).run.id, first.run.id);
  assert.equal(f.calls.filter(call => call.operation === "workflow.start").length, 2);
});

test("selection changes atomically for new issues while existing runs keep their approved pair", async t => {
  const f = fixture(t);
  const first = await f.start();
  const oldPhase = f.phase("implement");
  f.state.reviewer = 21;
  await assert.rejects(f.configure("failed-worker", "failed-review"), refused(403));
  assert.equal(f.selection()?.implementer, "implementer");
  f.state.reviewer = 23;

  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.intercept(async (operation, input) => {
    if (operation === "binding.approve" && input.context.model === "slow-worker") {
      entered();
      await held;
    }
  });
  const slow = f.configure("slow-worker", "slow-review");
  await waiting;
  await f.configure("next-worker", "next-review");
  release();
  await assert.rejects(slow, refused(409));
  assert.equal(f.selection()?.implementer, "implementer-next-worker");
  assert.equal(f.selection()?.reviewer, "reviewer-next-review");
  assert.equal((await f.start()).run.id, first.run.id);
  assert.equal((await f.prepare(oldPhase)).mode, "agent");
  await f.start({ ...pin, issueNumber: pin.issueNumber + 1 });
  assert.equal(f.state.inputs["implement.inputs.implementerBinding"], "implementer-next-worker");
  assert.equal(f.state.inputs["implement.inputs.reviewerBinding"], "reviewer-next-review");
});

test("draft preflight timeout preserves the write attempt and winning implementation summary", async t => {
  const f = fixture(t);
  await f.start();
  const first = f.phase("implement");
  f.intercept((operation, input) => {
    if (operation === "repository.request" && input.path === `${repo.path}/branches/${pin.baseRef}` &&
        f.state.head === commit) throw new Response("Preflight timed out", { status: 503 });
  });
  await assert.rejects(f.finalize(first), refused(503));
  assert.deepEqual(f.writes(), [`${repo.path}/branches`, `${repo.path}/contents`]);
  f.intercept(undefined);
  const result = await f.finalize(f.phase("implement", true));
  assert.match(JSON.stringify(result), /Checked fixture/);
  assert.equal(f.writes().filter(path => path?.endsWith("/pulls")).length, 1);
});

test("a lost Create PR response during ref drift retains the exact-run draft as blocked", async t => {
  const f = fixture(t);
  await f.start();
  Object.assign(f.state, { loseWrites: true, moveAfterPull: true });
  await assert.rejects(f.finalize(f.phase("implement")), refused(422));
  const receipt = await f.start();
  assert.equal(receipt.candidate, null);
  assert.equal(receipt.draftObservation?.status, "blocked");
  assert.equal(receipt.draftObservation?.number, 8);
  assert.equal(receipt.draftObservation?.url, draftUrl);
  assert.deepEqual(f.writes(), [`${repo.path}/branches`, `${repo.path}/contents`, `${repo.path}/pulls`]);
});

test("preflight failures before contents and review leave both writes available", async t => {
  const f = fixture(t);
  await f.start();
  const implement = f.phase("implement");
  const basePath = `${repo.path}/branches/${pin.baseRef}`;
  f.intercept((operation, input) => {
    if (operation === "repository.request" && input.path === basePath &&
        f.state.head === pin.baseSha && !f.state.message) throw new Response("Preflight timeout", { status: 503 });
  });
  await assert.rejects(f.finalize(implement), refused(503));
  assert.deepEqual(f.writes(), [`${repo.path}/branches`]);
  f.intercept(undefined);
  await f.finalize(implement);

  const review = f.phase("review");
  let reads = 0;
  f.intercept((operation, input) => {
    if (operation === "repository.request" && input.path === basePath &&
        ++reads === 2) throw new Response("Review preflight timeout", { status: 503 });
  });
  await assert.rejects(f.finalize(review), refused(503));
  assert.equal(f.state.reviews.length, 0);
  f.intercept(undefined);
  await f.finalize(review);
  assert.equal(f.state.reviews.length, 1);
});

test("deletions receive a terminal refusal before a branch or commit is written", async t => {
  const f = fixture(t);
  await f.start();
  const phase = f.phase("implement");
  phase.outputs.result = { summary: "Deletion would be required", files: [{ path: "example.md", content: null }] };
  await assert.rejects(f.finalize(phase), refused(422));
  assert.deepEqual(f.writes(), []);
});

test("a sanitized Forgejo outage leaves the draft claim available for read-only reconciliation", async t => {
  const f = fixture(t);
  await f.start();
  f.state.loseWrites = true;
  const implement = f.phase("implement");
  f.intercept((operation, input) => {
    if (operation === "repository.request" && f.state.pull && input.path.includes("/pulls?")) {
      const provider = new Response("Forgejo temporarily unavailable", { status: 502 });
      // The broker masks provider failures behind its generic authority response.
      throw new Response("Workspace repository unavailable", { status: provider.ok ? 200 : 403 });
    }
  });
  await assert.rejects(f.finalize(implement), refused(503));
  assert.equal((await f.start()).draftObservation?.status, "ambiguous");
  const writes = f.writes();
  assert.deepEqual(writes, [`${repo.path}/branches`, `${repo.path}/contents`, `${repo.path}/pulls`]);

  for (const status of [404, 422]) {
    f.intercept((operation, input) => {
      if (operation === "repository.request" && input.path === `${repo.path}/branches/${f.state.branch}`)
        throw new Response("Workspace repository unavailable", { status });
    });
    await assert.rejects(f.finalize(f.phase("implement", true)), refused(503));
    assert.equal((await f.start()).draftObservation?.status, "ambiguous");
  }
  f.intercept(undefined);
  await f.finalize(f.phase("implement", true));
  assert.equal((await f.start()).candidate?.number, 8);
  assert.deepEqual(f.writes(), writes);
});

test("a stale draft reconciliation cannot replace a blocked observation or accept a candidate", async t => {
  const f = fixture(t);
  await f.start();
  f.state.loseWrites = true;
  f.intercept((operation, input) => {
    if (operation === "repository.request" && f.state.pull && input.path.includes("/pulls?"))
      throw new Response("Lookup unavailable", { status: 503 });
  });
  await assert.rejects(f.finalize(f.phase("implement")), refused(503));

  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.intercept(async (operation, input) => {
    if (operation === "repository.request" && input.path.includes("/pulls?")) {
      entered();
      await held;
    }
  });
  const stale = f.finalize(f.phase("implement", true));
  const staleRefusal = assert.rejects(stale, refused(422));
  await waiting;
  try {
    f.intercept(undefined);
    f.state.baseSha = commit;
    await assert.rejects(f.finalize(f.phase("implement", true)), refused(422));
    assert.equal((await f.start()).draftObservation?.status, "blocked");
    f.state.baseSha = pin.baseSha;
  } finally {
    release();
  }
  await staleRefusal;
  const receipt = await f.start();
  assert.equal(receipt.candidate, null);
  assert.equal(receipt.draftObservation?.status, "blocked");
  assert.equal(receipt.draftObservation?.number, 8);
  assert.deepEqual(f.writes(), [`${repo.path}/branches`, `${repo.path}/contents`, `${repo.path}/pulls`]);
});


test("normalizes against pinned blob bytes before claiming the branch or freezing its proof", async t => {
  const f = fixture(t);
  await f.start();
  f.state.splitTree = true;
  const first = f.phase("implement");
  const unchanged = { path: "untouched.md", content: baseContent };
  first.outputs.result = { summary: "No byte changes", files: [unchanged] };
  await assert.rejects(f.finalize(first), refused(422));
  assert.deepEqual({ ...f.claim() }, { branchClaim: null, commitClaim: null, commitProof: null });
  assert.deepEqual(f.writes(), []);

  const next = f.phase("implement");
  next.outputs.result = { summary: "One byte change", files: [unchanged, { path: "example.md", content: "Updated æ\n" }] };
  await f.finalize(next);
  assert.equal((await f.start()).candidate?.number, 8);
  const proof = JSON.parse(String(f.claim()?.commitProof));
  assert.deepEqual(proof.files.map((file: { path: string }) => file.path), ["example.md"]);
});

test("pinned review proposals reject provider automation paths regardless of case", async t => {
  const f = fixture(t);
  await f.start();
  for (const path of [".FoRgEjO/Workflows/check.yml", ".GITEA/WORKFLOWS/check.yml", ".github/workflows/check.yml"]) {
    const phase = f.phase("implement");
    phase.outputs.result = { summary: "Provider automation", files: [{ path, content: "name: check" }] };
    await assert.rejects(f.finalize(phase), refused(422));
  }
  assert.equal(f.claim()?.branchClaim, null);
  assert.deepEqual(f.writes(), []);
});

test("another Forgejo author cannot publish or suppress the pinned reviewer's receipt", async t => {
  const f = fixture(t);
  await f.start();
  await f.finalize(f.phase("implement"));
  const review = f.phase("review");
  f.state.loseWrites = true;
  f.intercept((operation, input) => {
    if (operation === "repository.request" && input.path.endsWith("/reviews?limit=50") && f.state.reviews.length === 1) {
      f.state.reviews.unshift({ ...f.state.reviews[0], id: 61, user: { id: 99, login: "other" } });
      f.state.reviews.pop();
    }
  });
  await assert.rejects(f.finalize(review), refused(503));
  assert.equal((await f.start()).review, null);

  f.state.reviews.push({ ...f.state.reviews[0], id: 60, user: { id: 23, login: "independent" } });
  f.intercept(undefined);
  await f.finalize(f.phase("review", true));
  assert.equal((await f.start()).review?.id, 60);
  assert.equal(f.state.reviewWrites, 1);
});

const noSendMessage = "Pinned Forgejo mutation was not dispatched";

function isEffectCall(path: string, operation: string, input: Record<string, any>) {
  return path === "review"
    ? operation === "workspace.control" && input.operation === "publish-review"
    : operation === "repository.request" && input.method === "POST" && input.path === `${repo.path}/${path}`;
}

test("only the reserved no-send proof reopens each frozen effect for one provider POST", async t => {
  for (const path of ["branches", "contents", "pulls", "review"]) {
    const f = fixture(t);
    await f.start();
    const role = path === "review" ? "review" : "implement";
    if (role === "review") await f.finalize(f.phase("implement"));
    let refusedPayload: unknown;
    let sends = 0;
    f.intercept((operation, input) => {
      if (!isEffectCall(path, operation, input)) return;
      const payload = input.body ?? input;
      if (!refusedPayload) {
        refusedPayload = structuredClone(payload);
        throw new Response(noSendMessage, { status: 425 });
      }
      assert.deepEqual(payload, refusedPayload);
      sends++;
    });
    await assert.rejects(f.finalize(f.phase(role)), refused(503));
    assert.equal(sends, 0);
    const retry = f.phase(role, true);
    assert.equal((await f.prepare(retry)).mode, "coordinator");
    await f.finalize(retry);
    await f.finalize(f.phase(role, true));
    assert.equal(sends, 1, path);
  }
});

test("ambiguous failures and unmatched signals never replace a claimed effect", async t => {
  const errors = [
    new Response(noSendMessage + ".", { status: 425 }),
    new Response(noSendMessage, { status: 503 }),
    new DOMException("Provider request timed out", "TimeoutError"),
    new Error("Connection closed during dispatch"),
  ];
  for (const [index, path] of ["branches", "contents", "pulls", "review"].entries()) {
    const f = fixture(t);
    await f.start();
    const role = path === "review" ? "review" : "implement";
    if (role === "review") await f.finalize(f.phase("implement"));
    let attempts = 0;
    f.intercept((operation, input) => {
      if (!isEffectCall(path, operation, input)) return;
      attempts++;
      throw errors[index];
    });
    await assert.rejects(f.finalize(f.phase(role)), refused(503));
    await assert.rejects(f.finalize(f.phase(role, true)), refused(503));
    assert.equal(attempts, 1, path);
  }
});

test("concurrent retries consume the same affirmative refusal only once", async t => {
  const f = fixture(t);
  await f.start();
  let attempts = 0;
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.intercept(async (operation, input) => {
    if (!isEffectCall("contents", operation, input)) return;
    if (++attempts === 1) throw new Response(noSendMessage, { status: 425 });
    entered();
    await held;
  });
  await assert.rejects(f.finalize(f.phase("implement")), refused(503));
  const outcome = f.finalize(f.phase("implement", true));
  await waiting;
  try {
    await assert.rejects(f.finalize(f.phase("implement", true)), refused(503));
  } finally {
    release();
  }
  await outcome;
  assert.equal(attempts, 2);
  assert.equal((await f.start()).candidate?.number, 8);
});

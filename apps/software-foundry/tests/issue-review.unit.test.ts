import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { prepareResult, type PhaseInput, type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { documents } from "../src/server/documents";
import type { IntakeContext } from "../src/server/intake";
import {
  configureIssueReview, finalizeIssueReview, issueReviewWorkflow, prepareIssueReview, reviewForgejoIssue, reviewForgejoIssueInput,
} from "../src/server/workspace/issue-review";

const pin = { repository: "fixtures/rules", repositoryId: 45, issueNumber: 4, baseRef: "milestones/review", baseSha: "a".repeat(40) };
const commit = "b".repeat(40);
const baseBlob = "c".repeat(40);
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
    pull: null as Record<string, any> | null, reviews: [] as Record<string, any>[], reviewAttempt: "",
  };
  const runs = new Map<string, Record<string, unknown>>();
  const author = () => ({ id: state.reviewer, login: "independent" });
  const missing = () => new Response("Missing", { status: 404 });
  const lost = () => new Response("Receipt unavailable", { status: 502 });
  const host = {
    async call(operation: string, input: Record<string, any>) {
      calls.push({ operation, path: input.path, method: input.method });
      switch (operation) {
        case "snapshot":
          return { installation: { id: "installation", workflows: [issueReviewWorkflow] },
            bindings: ["implementer", "reviewer"].map(role => ({
              id: role, actor: role, enabled: true, kind: "external", workflowId: issueReviewWorkflow, label: role,
            })),
            connections: [{ id: state.connectionId, provider: "forgejo", owner: "organization",
              operations: ["issues.read"], repositories: state.granted ? [pin.repository] : [] }] };
        case "binding.approve":
          assert.equal(input.workspace.checkout, "forgejo-pinned");
          assert.equal(input.workspace.connectionId, "connection");
          assert.equal(input.workspace.inferenceProvider, "spark");
          assert.deepEqual(input.workspace.agentPermissions, { contents: "read", pull_requests: "read", issues: "read" });
          assert.equal(input.workspace.coordinatorPermissions.issues, "read");
          assert.equal(input.workspace.coordinatorPermissions.pull_requests, input.actor === "implementer" ? "write" : "read");
          return { id: input.actor };
        case "repository.read":
          assert.ok(["implementer", "reviewer"].includes(input.bindingId));
          return { ...repo, repositoryId: state.repoId, connectionId: state.connectionId };
        case "workflow.read":
          return runs.has(input.id) ? { run: { workflowId: issueReviewWorkflow, status: "running" }, inputs: runs.get(input.id) } : null;
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
          if (path === `/issues/${pin.issueNumber}`) return { state: state.issueOpen ? "open" : "closed",
            number: pin.issueNumber, title: "Fix an example", html_url: `${state.provider}/${pin.repository}/issues/${pin.issueNumber}` };
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
            if (state.splitTree) tree.push({ path: "untouched.md", type: "blob", mode: "100644", sha: "1".repeat(40) });
            if (!isBase && state.extraPath) tree.push({ path: "unassigned.md", type: "blob", mode: "100644", sha: "2".repeat(40) });
            const page = Number(new URL(path, origin).searchParams.get("page"));
            return { sha: isBase ? baseTree : headTree, tree: state.splitTree ? tree.slice(page - 1, page) : tree,
              total_count: tree.length, truncated: state.splitTree };
          }
          if (path === `/git/blobs/${updatedBlob}`)
            return { sha: updatedBlob, encoding: "base64", content: Buffer.from(state.providerContent).toString("base64") };
          if (path.startsWith("/branches/")) {
            if (!state.head || path !== `/branches/${state.branch}`) throw missing();
            return { name: state.branch, commit: { id: state.head } };
          }
          if (path === `/contents/example.md?ref=${pin.baseSha}`) return { type: "file", sha: baseBlob };
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
    prepare: (input: ReturnType<typeof phase>) => prepareIssueReview(host as unknown as WorkflowHost<"prepare">, db, input),
    finalize: (input: ReturnType<typeof phase>) => finalizeIssueReview(host as unknown as WorkflowHost<"finalize">, db, input),
    configure: () => configureIssueReview(host as unknown as WorkflowHost<"operator">, { operation: "configure-issue-review",
      repository: pin.repository, repositoryId: pin.repositoryId, reviewer: "reviewer", implementerModel: "worker", reviewerModel: "review-model" }),
    start: (input = pin) => reviewForgejoIssue(context, input),
    writes: () => calls.filter(call => call.method === "POST").map(call => call.path),
  };
}

const refused = (status: number) => (error: unknown) => error instanceof Response && error.status === status;

test("publishes the authenticated document and approves only its two pinned roles", async t => {
  assert.match(JSON.stringify(documents), /ReviewForgejoIssue/);
  assert.equal(reviewForgejoIssueInput.safeParse({ ...pin, baseRef: "refs/heads/main" }).success, false);
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
      "Return changed text files with their complete contents, or null to delete a file, plus actual check outcomes. Foundry publishes the branch and opens the draft.",
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
  assert.equal((await afterPull.start()).candidate, null);
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
  const second = await f.start();
  assert.notEqual(second.run.id, first.run.id);
  assert.equal((await f.start()).run.id, second.run.id);
  Object.assign(f.state, { provider: origin, connectionId: "connection" });
  assert.equal((await f.start()).run.id, first.run.id);
  assert.equal(f.calls.filter(call => call.operation === "workflow.start").length, 2);
});

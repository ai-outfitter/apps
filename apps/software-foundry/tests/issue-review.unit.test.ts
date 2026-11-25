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

const pin = { repository: "fixtures/rules", repositoryId: 45, issueNumber: 4, baseRef: "main", baseSha: "a".repeat(40) };
const commit = "b".repeat(40);
const origin = "https://forge.example";
const draftUrl = `${origin}/${pin.repository}/pulls/8`;
const repo = { name: pin.repository, repositoryId: pin.repositoryId, forge: "forgejo", appId: 21,
  path: `/repos/${pin.repository}`, installationId: 1, checkout: "forgejo-pinned", inferenceProvider: "spark", connectionId: "connection" };

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL("../migrations/0010_foundry_forgejo_issue_reviews.sql", import.meta.url), "utf8"));
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
    loseStart: false, loseWrites: false, missingCommit: false, moveAfterPull: false,
    head: null as string | null, branch: "", message: "", runId: "", inputs: {} as Record<string, any>,
    pull: null as Record<string, any> | null, reviews: [] as Record<string, any>[], reviewAttempt: "",
  };
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
            connections: [{ id: "connection", provider: "forgejo", owner: "organization",
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
          return { ...repo, repositoryId: state.repoId };
        case "workflow.read":
          return state.runId ? { run: { workflowId: issueReviewWorkflow, status: "running" }, inputs: state.inputs } : null;
        case "workflow.start": {
          const created = !state.runId;
          if (created) { state.runId = input.id; state.inputs = input.inputs; }
          else assert.deepEqual(input.inputs, state.inputs);
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
              assert.equal(input.body.files[0].sha, "c".repeat(40));
              assert.equal(Buffer.from(input.body.files[0].content, "base64").toString("utf8"), "Updated æ\n");
              state.message = input.body.message;
              if (!state.missingCommit) state.head = commit;
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
          if (path === "") return { id: state.repoId, full_name: pin.repository, html_url: `${origin}/${pin.repository}` };
          if (path === `/issues/${pin.issueNumber}`) return { state: state.issueOpen ? "open" : "closed",
            number: pin.issueNumber, title: "Fix an example", html_url: `${origin}/${pin.repository}/issues/${pin.issueNumber}` };
          if (path === "/branches/main") return { name: pin.baseRef, commit: { id: state.baseSha } };
          if (path === "/git/commits/" + commit) return { sha: commit, commit: { message: state.message }, parents: [{ sha: pin.baseSha }] };
          if (path.startsWith("/branches/")) {
            if (!state.head || path !== `/branches/${state.branch}`) throw missing();
            return { name: state.branch, commit: { id: state.head } };
          }
          if (path === `/contents/example.md?ref=${pin.baseSha}`) return { type: "file", sha: "c".repeat(40) };
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
      `Work in the local repo checkout from main at ${pin.baseSha}. Check that exact revision before editing.`,
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
  await assert.rejects(f.prepare(implement), refused(409));
  await assert.rejects(f.finalize(implement), refused(409));
  assert.deepEqual(f.writes(), []);
  f.state.baseSha = pin.baseSha;
  await f.finalize(implement);
  const review = f.phase("review");
  await assert.rejects(f.prepare({ ...review, settings: { role: "review" } }), refused(403));
  f.state.pull!.head.sha = "d".repeat(40);
  await assert.rejects(f.prepare(review), refused(409));
  f.state.pull!.head.sha = commit;
  f.state.reviewer = 99;
  await assert.rejects(f.finalize(review), refused(403));
  assert.equal(f.state.reviews.length, 0);
});

test("never retries an unseen commit or reports a draft after the base moves during creation", async t => {
  const f = fixture(t);
  await f.start();
  f.state.missingCommit = true;
  await assert.rejects(f.finalize(f.phase("implement")), refused(409));
  await assert.rejects(f.finalize(f.phase("implement", true)), refused(409));
  assert.deepEqual(f.writes(), [`${repo.path}/branches`, `${repo.path}/contents`]);

  const afterPull = fixture(t);
  await afterPull.start();
  afterPull.state.moveAfterPull = true;
  await assert.rejects(afterPull.finalize(afterPull.phase("implement")), refused(409));
  assert.equal((await afterPull.start()).candidate, null);
  assert.equal(afterPull.writes().length, 3);
});

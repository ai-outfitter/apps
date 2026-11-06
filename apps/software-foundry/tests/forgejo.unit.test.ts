import assert from "node:assert/strict";
import test from "node:test";
import { foundryForge, GithubFoundryForge } from "../src/server/workspace/forge";
import { closesIssue, ForgejoFoundryForge } from "../src/server/workspace/forgejo";

const head = "a".repeat(40);
const merged = "b".repeat(40);
const bot = 3;
const reviewer = { id: 4, login: "reviewer" };
const branch = "outfitter/issue-1-run";
const candidate = { number: 2, headSha: head, branch, url: "http://127.0.0.1:3000/box/repo/pulls/2" };
const review = { id: 9, url: candidate.url, headSha: head, verdict: "approved" as const, reviewer };

/** Asserts the call is refused with a 409 carrying this message. */
async function refused(call: Promise<unknown>, message: string) {
  const error = await call.then(() => assert.fail("expected a refusal"), (reason: Response) => reason);
  assert.equal(error.status, 409);
  assert.equal(await error.text(), message);
}

function fake() {
  const pull = {
    number: 2, state: "open", merged: false, merge_commit_sha: null as string | null, title: "WIP: feat: export CSV",
    body: "Adds export.\n\nCloses #1", html_url: candidate.url, user: { id: 5 },
    head: { sha: head, ref: branch, repo: { full_name: "box/repo" } }, base: { ref: "main", repo: { full_name: "box/repo" } },
  };
  const statuses: any[] = [];
  const comments: any[] = [];
  const reviews: any[] = [{ id: 9, state: "APPROVED", commit_id: head, user: reviewer, stale: false, dismissed: false }];
  const calls: [string, string, unknown][] = [];
  const api = async (path: string, body?: any, method?: string): Promise<any> => {
    const verb = method ?? (body === undefined ? "GET" : "POST");
    calls.push([verb, path, body]);
    if (path === "/repos/box/repo") return { default_branch: "main" };
    if (path === "/repos/box/repo/issues/1") return { number: 1, title: "Export CSV", body: "x", state: "open", html_url: "i", pull_request: null };
    if (path === "/repos/box/repo/pulls/2" && verb === "PATCH") return Object.assign(pull, body);
    if (path === "/repos/box/repo/pulls/2") return structuredClone(pull);
    if (path.startsWith("/repos/box/repo/issues/1/comments?")) return comments;
    if (path === "/repos/box/repo/issues/1/comments") {
      const comment = { id: comments.length + 1, body: body.body, user: { id: bot }, html_url: `c${comments.length + 1}` };
      comments.push(comment);
      return comment;
    }
    if (path.startsWith(`/repos/box/repo/commits/${head}/statuses`)) return statuses;
    if (path === `/repos/box/repo/statuses/${head}`) {
      const status = { id: statuses.length + 1, ...body, creator: { id: bot } };
      statuses.push(status);
      return status;
    }
    if (path.startsWith("/repos/box/repo/pulls/2/reviews")) return reviews;
    if (path === "/repos/box/repo/pulls/2/merge") {
      Object.assign(pull, { merged: true, state: "closed", merge_commit_sha: merged });
      return {};
    }
    throw new Error(`unexpected ${verb} ${path}`);
  };
  return { api, pull, statuses, comments, reviews, calls, forge: new ForgejoFoundryForge(api, "box/repo", bot) };
}

test("the factory picks Forgejo only when the host names it", () => {
  const api = async () => ({});
  assert.ok(foundryForge(api, { name: "box/repo", appId: 3, forge: "forgejo" }) instanceof ForgejoFoundryForge);
  assert.ok(foundryForge(api, { name: "acme/app", appId: 3 }) instanceof GithubFoundryForge);
});

test("closing keywords link the issue, and only that issue", () => {
  assert.equal(closesIssue("Fixes #12", 12), true);
  assert.equal(closesIssue("resolves #12.", 12), true);
  assert.equal(closesIssue("Closes #123", 12), false);
  assert.equal(closesIssue("See #12", 12), false);
});

test("reads the issue and pins the change to its branch, default branch and closing issue", async () => {
  const { forge, pull } = fake();
  assert.equal((await forge.issue(1)).title, "Export CSV");
  assert.deepEqual(await forge.change(candidate, 1, branch), { number: 2, headSha: head, branch, url: candidate.url });
  await assert.rejects(forge.change(candidate, 7, branch), (error: Response) => error.status === 409);
  pull.base.ref = "release";
  await assert.rejects(forge.change(candidate, 1, branch), (error: Response) => error.status === 409);
});

test("readiness removes the WIP prefix", async () => {
  const { forge, pull } = fake();
  await forge.ready(candidate);
  assert.equal(pull.title, "feat: export CSV");
});

test("triage comments and check statuses are published once per attempt", async () => {
  const { forge, comments, statuses } = fake();
  await forge.comment(1, "attempt-1", "Plan");
  await forge.comment(1, "attempt-1", "Plan");
  assert.equal(comments.length, 1);
  const results = [{ name: "unit", headSha: head, passed: true }];
  assert.deepEqual(await forge.checks(candidate, results, "attempt-1"), [{ name: "unit", headSha: head, passed: true, url: undefined }]);
  await forge.checks(candidate, results, "attempt-1");
  assert.equal(statuses.length, 1);
  await forge.checks(candidate, results, "attempt-2");
  assert.equal(statuses.length, 2);
});

test("merges at the reviewed head only with current approval and passing statuses", async () => {
  const { forge, statuses, reviews, calls } = fake();
  await assert.rejects(forge.merge(candidate, review, ["unit"], true), (error: Response) => error.status === 409);
  statuses.push({ id: 1, context: "unit", state: "success", creator: { id: bot } });
  reviews[0].stale = true;
  await refused(forge.merge(candidate, review, ["unit"], true), "Current independent formal approval required");
  reviews[0].stale = false;
  assert.deepEqual(await forge.merge(candidate, review, ["unit"], true), { url: candidate.url, headSha: head, mergeSha: merged });
  assert.deepEqual(calls.find(([, path]) => path.endsWith("/merge"))?.[2], { Do: "squash", head_commit_id: head });
  assert.deepEqual(await forge.merge(candidate, review, ["unit"], false), { url: candidate.url, headSha: head, mergeSha: merged });
});

test("a status from another user does not count as a required check", async () => {
  const { forge, statuses } = fake();
  statuses.push({ id: 1, context: "unit", state: "success", creator: { id: 99 } });
  await refused(forge.merge(candidate, review, ["unit"], false), "Current required checks required");
});

test("the PR author cannot approve their own change", async () => {
  const { forge, pull } = fake();
  pull.user.id = reviewer.id;
  await refused(forge.approval(candidate, review), "Current independent formal approval required");
});

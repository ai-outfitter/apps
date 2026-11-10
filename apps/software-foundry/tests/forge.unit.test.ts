import assert from "node:assert/strict";
import test from "node:test";
import { GithubFoundryForge } from "../src/server/workspace/forge";
import {
  launchFoundryWorkspaceIssue,
  foundryChecks,
  foundryIssueRunId,
} from "../src/server/workspace/workspaces";
import { workspaceAgentPermissions, workspaceCoordinatorPermissions } from "../src/server/workspace/execution";

const head = "a".repeat(40),
  merged = "b".repeat(40);

test("reviewer credentials include repository-scoped read-only Actions evidence", () => {
  assert.deepEqual(workspaceAgentPermissions("review"), { checks: "read", actions: "read" });
  assert.deepEqual(workspaceAgentPermissions("implement"), {});
});
const candidate = {
  number: 7,
  headSha: head,
  branch: "outfitter/issue-3-run",
  url: "https://github.com/acme/widgets/pull/7",
};
const review = {
  id: 8,
  url: candidate.url,
  headSha: head,
  verdict: "approved" as const,
  reviewer: { id: 20, login: "reviewer" },
};

function forgeFixture(checkAppId = 42) {
  const pull = {
    number: 7,
    state: "open",
    draft: false,
    merged: false,
    merge_commit_sha: null as string | null,
    node_id: "PR_7",
    html_url: candidate.url,
    user: { id: 10 },
    head: {
      sha: head,
      ref: candidate.branch,
      repo: { full_name: "acme/widgets" },
    },
    base: { ref: "main", repo: { full_name: "acme/widgets" } },
  };
  const reviews = [
    { id: 8, state: "APPROVED", commit_id: head, user: { id: 20 } },
  ];
  const checks = [
    {
      id: 9,
      app: { id: 42 },
      name: "test",
      status: "completed",
      conclusion: "success",
    },
  ];
  let linked = true,
    queued = false;
  const writes: { path: string; body: any; method?: string }[] = [];
  const graphql = (body: any) => {
    if (body.query.includes("markPullRequestReadyForReview")) {
      pull.draft = false;
      return { data: { markPullRequestReadyForReview: { pullRequest: { id: pull.node_id } } } };
    }
    if (body.query.includes("closingIssuesReferences"))
      return {
        data: {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: linked
                  ? [
                      {
                        number: 3,
                        repository: { nameWithOwner: "acme/widgets" },
                      },
                    ]
                  : [],
              },
            },
          },
        },
      };
    if (body.query.includes("enqueuePullRequest")) {
      queued = true;
      return { data: {} };
    }
    return {
      data: { node: { mergeQueueEntry: queued ? { id: "Q1" } : null } },
    };
  };
  const api = async (
    path: string,
    body?: any,
    method?: string,
  ): Promise<any> => {
    if (body && !body.query?.startsWith("query"))
      writes.push({ path, body, method });
    if (path === "/repos/acme/widgets") return { default_branch: "main" };
    if (path.endsWith("/reviews?per_page=100")) return reviews;
    if (path.includes("/check-runs?"))
      return { total_count: checks.length, check_runs: checks };
    if (path === "/graphql") return graphql(body);
    if (path.endsWith("/merge")) {
      pull.merged = true;
      pull.merge_commit_sha = merged;
      return { merged: true };
    }
    return pull;
  };
  return {
    forge: new GithubFoundryForge(api, "acme/widgets", 42, checkAppId),
    pull,
    reviews,
    checks,
    writes,
    unlink: () => {
      linked = false;
    },
  };
}

test("issue starts are stable per installation and explicit resume is independently idempotent", async () => {
  const first = await foundryIssueRunId("org-install", "123", 3);
  assert.equal(first, await foundryIssueRunId("org-install", "123", 3));
  assert.notEqual(first, await foundryIssueRunId("other-install", "123", 3));
  assert.notEqual(
    first,
    await foundryIssueRunId("org-install", "123", 3, "reply-4"),
  );
  assert.equal(
    await foundryIssueRunId("org-install", "123", 3, "reply-4"),
    await foundryIssueRunId("org-install", "123", 3, "reply-4"),
  );
  assert.deepEqual(
    foundryChecks("ai-outfitter/webapp").map((check) => check.name),
    ["check", "integration", "browser-e2e (node)", "browser-e2e (cloudflare)"],
  );
});

test("candidate admission requires the assigned branch, current head, native closing link and default target", async () => {
  const f = forgeFixture();
  assert.deepEqual(
    await f.forge.change(candidate, 3, candidate.branch),
    candidate,
  );
  f.pull.base.ref = "unprotected";
  await assert.rejects(
    f.forge.change(candidate, 3, candidate.branch),
    (error) => error instanceof Response && error.status === 409,
  );
  f.pull.base.ref = "main";
  f.pull.head.sha = merged;
  await assert.rejects(f.forge.change(candidate, 3, candidate.branch));
  f.pull.head.sha = head;
  f.unlink();
  await assert.rejects(f.forge.change(candidate, 3, candidate.branch));
  assert.equal(f.writes.length, 0);
});

test("draft readiness requires a confirmed mutation and current ready commit", async () => {
  const f = forgeFixture();
  f.pull.draft = true;
  await f.forge.ready(candidate);
  assert.equal(f.pull.draft, false);
  assert.equal(f.writes.length, 1);
  await f.forge.ready(candidate);
  assert.equal(f.writes.length, 1, "a recovered readiness response must not repeat the mutation");
  f.pull.head.sha = merged;
  await assert.rejects(f.forge.ready(candidate));
});

test("HTTP-success GraphQL denials cannot silently pass draft readiness", async () => {
  const forge = new GithubFoundryForge(async (path: string): Promise<any> => path === "/graphql"
    ? { errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] }
    : { head: { sha: head }, draft: true, node_id: "PR_7" }, "acme/widgets", 42);
  await assert.rejects(forge.ready(candidate), (error) => error instanceof Response && error.status === 403);
});

test("landing rechecks independent current approval and App-issued checks and confirms the actual merge", async () => {
  const f = forgeFixture();
  f.checks[0].app.id = 999;
  await assert.rejects(f.forge.merge(candidate, review, ["test"], false));
  assert.equal(f.writes.length, 0);
  f.checks[0].app.id = 42;
  f.reviews.push({
    id: 10,
    state: "CHANGES_REQUESTED",
    commit_id: head,
    user: { id: 20 },
  });
  await assert.rejects(f.forge.merge(candidate, review, ["test"], false));
  f.reviews.pop();
  assert.deepEqual(await f.forge.merge(candidate, review, ["test"], false), {
    url: candidate.url,
    headSha: head,
    mergeSha: merged,
  });
  assert.equal(f.writes.at(-1)?.method, "PUT");
  assert.equal(f.writes.at(-1)?.body.sha, head);
  const count = f.writes.length;
  assert.deepEqual(await f.forge.merge(candidate, review, ["test"], false), {
    url: candidate.url,
    headSha: head,
    mergeSha: merged,
  });
  assert.equal(f.writes.length, count);
});

test("merge queue enqueue is idempotent and never claims a queued PR is merged", async () => {
  const f = forgeFixture();
  assert.equal(await f.forge.merge(candidate, review, ["test"], true), null);
  assert.equal(await f.forge.merge(candidate, review, ["test"], true), null);
  assert.equal(
    f.writes.filter((write) => write.body.query?.includes("enqueuePullRequest"))
      .length,
    1,
  );
  assert.equal(f.writes.filter((write) => write.method === "PUT").length, 0);
});

test("coordinator validation and landing scopes allow their required operations without granting queue access to other roles", () => {
  const validation = workspaceCoordinatorPermissions({ role: "validate", mergeQueue: true });
  assert.equal(validation.contents, "write", "draft readiness needs repository write authority");
  assert.equal(validation.checks, "write");
  assert.equal(validation.merge_queues, undefined);
  assert.equal(workspaceCoordinatorPermissions({ role: "land", mergeQueue: false }).checks, "read");
  assert.equal(workspaceCoordinatorPermissions({ role: "land", mergeQueue: false }).merge_queues, undefined);
  assert.equal(workspaceCoordinatorPermissions({ role: "land", mergeQueue: true }).merge_queues, "write");
  for (const role of ["triage", "implement", "review", "repair"] as const) {
    const permissions = workspaceCoordinatorPermissions({ role, mergeQueue: true });
    assert.equal(permissions.contents, "read");
    assert.equal(permissions.merge_queues, undefined);
  }
});


test("the issue adapter returns a provider-neutral receipt from the scoped issue and rejects PRs or mismatched identifiers", async () => {
  const issue: { number: number; title: string; body: string | null; html_url: string; state: string; pull_request?: object } = {
    number: 3, title: "Reconcile split cents", body: null, html_url: "https://github.com/acme/widgets/issues/3", state: "open",
  };
  const forge = new GithubFoundryForge(async (path: string): Promise<any> => {
    assert.equal(path, "/repos/acme/widgets/issues/3");
    return issue;
  }, "acme/widgets", 42);
  assert.deepEqual(await forge.issue(3), { number: 3, repository: "acme/widgets", title: issue.title, body: "", url: issue.html_url, state: "open" });
  issue.number = 4;
  await assert.rejects(forge.issue(3));
  issue.number = 3;
  issue.pull_request = {};
  await assert.rejects(forge.issue(3));
  delete issue.pull_request;
  issue.state = "unknown";
  await assert.rejects(forge.issue(3));
});


test("protected landing accepts Actions checks and rejects stale or Outfitter-issued substitutes", async () => {
  const f = forgeFixture(15368);
  const check = f.checks[0] as typeof f.checks[0] & { head_sha?: string };
  await assert.rejects(f.forge.merge(candidate, review, ["test"], true));
  check.app.id = 15368;
  check.head_sha = "b".repeat(40);
  await assert.rejects(f.forge.merge(candidate, review, ["test"], true));
  check.head_sha = head;
  assert.equal(await f.forge.merge(candidate, review, ["test"], true), null);
  check.conclusion = "failure";
  await assert.rejects(f.forge.merge(candidate, review, ["test"], true));
});


test("approval reuse re-reads the current independent formal review and rejects invalidation", async () => {
  const { forge, pull, reviews, writes } = forgeFixture();
  await forge.approval(candidate, review);
  assert.deepEqual(writes, [], "reuse never publishes another review");
  for (const state of ["DISMISSED", "CHANGES_REQUESTED", "COMMENTED"]) {
    reviews[0].state = state;
    await assert.rejects(forge.approval(candidate, review), (error: unknown) => error instanceof Response && error.status === 409);
  }
  reviews[0].state = "APPROVED";
  // A later comment-only review by the reviewer's account leaves the approval current.
  reviews.push({ ...reviews[0], id: 9, state: "COMMENTED" });
  await forge.approval(candidate, review);
  reviews.pop();
  // So does another agent's later approval of the same head.
  reviews.push({ ...reviews[0], id: 9 });
  await forge.approval(candidate, review);
  for (const later of [{ state: "CHANGES_REQUESTED" }, { state: "DISMISSED" }, { commit_id: "c".repeat(40) }]) {
    reviews[1] = { ...reviews[0], id: 9, ...later };
    await assert.rejects(forge.approval(candidate, review), (error: unknown) => error instanceof Response && error.status === 409);
  }
  reviews.pop();
  pull.head.sha = "c".repeat(40);
  await assert.rejects(forge.approval(candidate, review), (error: unknown) => error instanceof Response && error.status === 409);
  pull.head.sha = head;
  pull.user.id = review.reviewer.id;
  await assert.rejects(forge.approval(candidate, review), (error: unknown) => error instanceof Response && error.status === 409);
});


test("explicit resumes retain the original implementation branch across repeated recovery", async () => {
  const original = "11111111-1111-4111-8111-111111111111", priorId = "22222222-2222-4222-8222-222222222222";
  for (const sourceRunId of [undefined, original]) {
    let started: any;
    const event = { repository: { id: 123 }, issue: { number: 3 }, ...(sourceRunId ? { sourceRunId } : {}) };
    const prior = { run: { id: priorId, workflowId: "issue-to-merge-actions-ci", status: "failed" }, inputs: { "triage.inputs.event": event }, outputs: {}, attempts: [] };
    const host = { call: async (operation: string, input: any) => {
      if (operation === "workflow.references") return [];
      if (operation === "workflow.read") return prior;
      if (operation === "workflow.start") { started = input; return { id: input.id, created: true }; }
      throw new Error(operation);
    } } as unknown as Parameters<typeof launchFoundryWorkspaceIssue>[0];
    await launchFoundryWorkspaceIssue(host, { resource: "123", inputs: {} }, event, "33333333-3333-4333-8333-333333333333", {
      host: host as any, snapshot: {} as any, request: { runId: priorId, requestId: "44444444-4444-4444-8444-444444444444" },
    });
    assert.equal(started.inputs["triage.inputs.event"].sourceRunId, sourceRunId ?? priorId);
    assert.equal(started.inputs["triage.inputs.event"].previousRunId, priorId);
  }
});

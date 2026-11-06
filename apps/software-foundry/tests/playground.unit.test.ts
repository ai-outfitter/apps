import assert from "node:assert/strict";
import test from "node:test";
import {
  BASELINE,
  REPOSITORY_ID,
  resetFoundryPlayground,
  TARGET,
} from "../scripts/reset-playground.mjs";
import { reviewedProof, runPlayground } from "../scripts/playground.mjs";
const head = "a".repeat(40),
  candidateHead = "c".repeat(40);
function fixture() {
  const state = {
    id: REPOSITORY_ID,
    private: true,
    head,
    force: false,
    admins: true,
    ci: "active",
    agent: "disabled_manually",
    failForce: false,
    race: false,
    issues: [
      {
        number: 10,
        node_id: "I10",
        title: "Old proof",
        html_url: `https://github.com/${TARGET}/issues/10`,
      },
    ],
    pulls: [
      {
        number: 9,
        state: "open",
        head: { sha: head },
        html_url: `https://github.com/${TARGET}/pull/9`,
      },
    ],
    branches: [
      { name: "main", protected: true },
      { name: "outfitter/old", protected: false },
    ],
  };
  const calls: { method: string; path: string; body: any }[] = [];
  const protection = () => ({
    enforce_admins: { enabled: state.admins },
    allow_force_pushes: { enabled: state.force },
    required_pull_request_reviews: {
      require_code_owner_reviews: true,
      required_approving_review_count: 1,
    },
    required_status_checks: { checks: [{ context: "test", app_id: 15368 }] },
  });
  const inspection: any = {
    repository: TARGET,
    repositoryId: REPOSITORY_ID,
    workflow: "issue-to-merge-actions-ci",
    installationId: "app",
    subscriptionId: "subscription",
    reviewer: { id: 20, login: "vega-unsup" },
    configurationValid: true,
    activeRunIds: [],
    pendingDeliveryIds: [],
    url: "https://software-foundry.outfitter.ai-outfitter.com/workflows",
    run: null,
  };
  let proofBody = "";
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: explicit protocol fixture asserts every allowed side effect
  const request = async (input: any, init: any = {}) => {
    const url = new URL(String(input)),
      method = init.method ?? "GET",
      body = init.body ? JSON.parse(init.body) : undefined;
    assert.equal(init.redirect, "manual");
    calls.push({ method, path: url.pathname, body });
    const json = (value: any, status = 200) =>
      new Response(JSON.stringify(value), { status });
    if (url.hostname === "ai-outfitter.com") {
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        "Bearer gateway-only",
      );
      assert.deepEqual(Object.keys(body).sort(), ["connectionId", "input", "organization"]);
      if (body.input.operation === "configure") {
        inspection.configurationValid = true;
        return json({ configured: true });
      }
      if (body.input.operation === "start") return json({ id: "run" });
      return json(inspection);
    }
    assert.equal(url.hostname, "api.github.com");
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer operator-only",
    );
    const prefix = `/repos/${TARGET}`,
      suffix = url.pathname.slice(prefix.length);
    if (url.pathname === "/graphql") {
      if (body.query.startsWith("query"))
        return json({
          data: {
            repository: {
              databaseId: state.id,
              branchProtectionRules: {
                nodes: [
                  {
                    id: "RULE",
                    pattern: "main",
                    allowsForcePushes: state.force,
                    isAdminEnforced: state.admins,
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        });
      if (body.variables.input) {
        state.force = body.variables.input.allowsForcePushes;
        state.admins = body.variables.input.isAdminEnforced;
        return json({
          data: {
            updateBranchProtectionRule: {
              branchProtectionRule: {
                id: "RULE",
                allowsForcePushes: state.force,
                isAdminEnforced: state.admins,
              },
            },
          },
        });
      }
      if (body.variables.id) {
        state.issues = state.issues.filter(
          (item) => item.node_id !== body.variables.id,
        );
        return json({
          data: { deleteIssue: { repository: { databaseId: state.id } } },
        });
      }
    }
    if (suffix === "")
      return json({
        id: state.id,
        full_name: TARGET,
        private: state.private,
        default_branch: "main",
        permissions: { admin: true },
      });
    if (suffix === "/git/ref/heads/main")
      return json({
        object: {
          sha: state.race && state.force ? "b".repeat(40) : state.head,
        },
      });
    if (suffix === `/git/commits/${BASELINE}`) return json({ sha: BASELINE });
    if (suffix === "/branches/main/protection") return json(protection());
    if (suffix === "/rulesets") return json([]);
    if (suffix === "/actions/workflows")
      return json({
        workflows: [
          { id: 1, path: ".github/workflows/test.yml", state: state.ci },
          {
            id: 2,
            path: ".github/workflows/outfitter-implement.yml",
            state: state.agent,
          },
          {
            id: 3,
            path: ".github/workflows/outfitter-managed-node.yml",
            state: state.agent,
          },
        ],
      });
    if (suffix === "/pulls")
      return json(state.pulls.filter((item) => item.state === "open"));
    if (suffix === "/issues" && method === "GET") return json(state.issues);
    if (suffix === "/branches") return json(state.branches);
    if (suffix === "/pulls/9" && method === "PATCH") {
      state.pulls[0].state = "closed";
      return json(state.pulls[0]);
    }
    if (suffix.startsWith("/git/refs/heads/") && method === "DELETE") {
      state.branches = state.branches.filter(
        (item) =>
          item.name !==
          decodeURIComponent(suffix.slice("/git/refs/heads/".length)),
      );
      return new Response(null, { status: 204 });
    }
    if (suffix === "/git/refs/heads/main" && method === "PATCH") {
      assert.equal(state.force, true);
      assert.equal(state.admins, false);
      assert.equal(body.force, true);
      state.head = body.sha;
      if (state.failForce)
        throw Error("lost response with secret provider details");
      return json({ object: { sha: state.head } });
    }
    if (suffix === "/issues" && method === "POST") {
      assert.equal(state.admins, true);
      assert.equal(state.force, false);
      assert.equal(state.head, BASELINE);
      proofBody = body.body;
      return json(
        { number: 19, html_url: `https://github.com/${TARGET}/issues/19` },
        201,
      );
    }
    if (suffix === "/pulls/20")
      return json({
        head: { sha: candidateHead },
        user: { id: 10 },
        merged: false,
      });
    if (suffix === "/pulls/20/reviews")
      return json([
        {
          id: 30,
          commit_id: candidateHead,
          state: "APPROVED",
          user: { id: 20 },
        },
      ]);
    assert.fail(`Unexpected call ${method} ${url}`);
  };
  const writes = () =>
    calls.filter(
      (call) =>
        call.method !== "GET" &&
        (call.path !== "/graphql" || !call.body.query.startsWith("query")) &&
        call.body?.input?.operation !== "inspect",
    );
  const reset = (apply = false) =>
    resetFoundryPlayground({
      apply,
      token: "operator-only",
      request,
      assertIdle: async () => {
        if (inspection.activeRunIds.length) throw Error("active run");
      },
    });
  const run = (options: any = {}) =>
    runPlayground({
      token: "operator-only",
      gatewayToken: "gateway-only",
      request,
      wait: false,
      ...options,
    });
  return {
    state,
    calls,
    inspection,
    request,
    reset,
    run,
    writes,
    proofBody: () => proofBody,
  };
}
test("reset preflight is read-only and preserves the configured repository identity", async () => {
  const f = fixture();
  const result = await f.reset();
  assert.equal(result.repositoryId, REPOSITORY_ID);
  assert.equal(result.baseline, BASELINE);
  assert.deepEqual(f.writes(), []);
  assert.equal(
    f.calls.some((call) => call.path === "/user/repos"),
    false,
  );
});
test("in-place reset closes PRs, deletes issues/branches and restores the exact protection without deleting or generating a repository", async () => {
  const f = fixture();
  const result = await f.reset(true);
  assert.equal(result.protectionRestored, true);
  assert.equal(f.state.id, REPOSITORY_ID);
  assert.equal(f.state.head, BASELINE);
  assert.equal(f.state.admins, true);
  assert.equal(f.state.force, false);
  assert.equal(f.state.pulls[0].state, "closed");
  assert.deepEqual(f.state.issues, []);
  assert.deepEqual(f.state.branches, [{ name: "main", protected: true }]);
  assert.equal(
    f
      .writes()
      .some(
        (call) => call.method === "DELETE" && call.path === `/repos/${TARGET}`,
      ),
    false,
  );
  assert.equal(
    f.writes().some((call) => call.path.endsWith("/generate")),
    false,
  );
});
test("wrong identity, public repository and Actions agent execution fail before mutations", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.state.id++,
    (f: ReturnType<typeof fixture>) => (f.state.private = false),
    (f: ReturnType<typeof fixture>) => (f.state.agent = "active"),
    (f: ReturnType<typeof fixture>) => (f.state.ci = "disabled_manually"),
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(f.reset(true));
    assert.deepEqual(f.writes(), []);
  }
});
test("active Foundry work prevents reset and proof issue creation", async () => {
  const f = fixture();
  f.inspection.activeRunIds = ["running-proof"];
  await assert.rejects(f.run({ apply: true }), /must settle/);
  assert.deepEqual(f.writes(), []);
});
test("lost force-update responses and concurrent main changes still restore protections and never create a proof issue", async () => {
  for (const option of ["failForce", "race"] as const) {
    const f = fixture();
    f.state[option] = true;
    await assert.rejects(f.reset(true));
    assert.equal(f.state.admins, true);
    assert.equal(f.state.force, false);
    assert.equal(
      f.calls.some(
        (call) => call.path.endsWith("/issues") && call.method === "POST",
      ),
      false,
    );
  }
});
test("standard replay creates an issue only after protected in-place reset, records the receipt and waits for signed webhook intake", async () => {
  const f = fixture();
  const result = await f.run({ apply: true });
  assert.ok("number" in result);
  assert.equal(result.number, 19);
  assert.match(f.proofBody(), new RegExp(String(REPOSITORY_ID)));
  assert.match(f.proofBody(), /protectionRestored/);
  assert.match(f.proofBody(), /outfitter:playground-proof:/);
  assert.equal(
    f.calls.filter((call) => call.body?.input?.operation === "start").length,
    0,
  );
  assert.equal(
    f.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/issues"),
    ).length,
    1,
  );
});
test("observing an existing issue does not reset, create an issue or dispatch agents", async () => {
  const f = fixture();
  await f.run({ number: 19 });
  assert.deepEqual(f.writes(), []);
  assert.equal(f.state.head, head);
});
test("formal-review proof must exist both in workflow outputs and GitHub at the exact candidate commit", async () => {
  const f = fixture();
  const value = {
    candidate: { number: 20, headSha: candidateHead },
    passed: true,
    checks: [{ name: "test", passed: true, headSha: candidateHead }],
    review: {
      id: 30,
      headSha: candidateHead,
      verdict: "approved",
      reviewer: { id: 20, login: "vega-unsup" },
    },
    evidence: [],
  };
  f.inspection.run = {
    id: "run",
    intake: [
      {
        provider: "connector:github",
        status: "delivered",
        deliveryId: "delivery",
      },
    ],
    url: "https://software-foundry.outfitter.ai-outfitter.com/workflows?run=run",
    rows: { "review.outputs.result": { complete: true, value } },
  };
  const api = async (method: string, path: string) => {
    const response = await f.request(`https://api.github.com${path}`, {
      method,
      redirect: "manual",
      headers: { Authorization: "Bearer operator-only" },
    });
    return response.json();
  };
  assert.equal((await reviewedProof(api, f.inspection))?.status, "reviewed");
  value.review.headSha = head;
  await assert.rejects(
    reviewedProof(api, f.inspection),
    /Invalid recorded review/,
  );
  value.review.headSha = candidateHead;
  value.checks[0].passed = false;
  await assert.rejects(reviewedProof(api, f.inspection), /exact-commit CI/);
  value.checks[0].passed = true;
  f.inspection.run.rows["review.outputs.result"].complete = false;
  assert.equal(await reviewedProof(api, f.inspection), null);
});

test("queued connector work prevents reset even before its workflow starts", async () => {
  const f = fixture();
  f.inspection.pendingDeliveryIds = ["queued-delivery"];
  await assert.rejects(f.run({ apply: true }), /must settle/);
  assert.deepEqual(f.writes(), []);
});

test("an idle approved connection can refresh stale package bindings without replacing the repository or granting a new account", async () => {
  const f = fixture();
  f.inspection.configurationValid = false;
  await f.run({ apply: true });
  assert.equal(
    f.calls.filter((call) => call.body?.input?.operation === "configure").length,
    1,
  );
  assert.equal(f.state.id, REPOSITORY_ID);
});

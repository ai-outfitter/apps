import assert from "node:assert/strict";
import test from "node:test";
import { actionsChecks, actionsPreview, githubActionsAppId } from "../src/server/workspace/actions-ci";

import { coordinatedRole, workspaceCoordinatorPermissions } from "../src/server/workspace/execution";

const head = "a".repeat(40);
const candidate = { number: 7, headSha: head, branch: "outfitter/issue-324-run", url: "https://github.com/acme/app/pull/7" };
const check = (name = "test", id = 1) => ({ id, name, head_sha: head, app: { id: githubActionsAppId }, status: "completed", conclusion: "success", html_url: "https://github.com/acme/app/actions/runs/1" });
const status = (expected: number) => (error: unknown) => error instanceof Response && error.status === expected;

test("CI coordination waits for missing/running results and ignores stale commits and other issuers", async () => {
  let checks: any[] = [];
  const api = async () => ({ total_count: checks.length, check_runs: checks });
  await assert.rejects(actionsChecks(api, "acme/app", candidate, ["test"]), status(425));
  checks = [{ ...check(), head_sha: "b".repeat(40) }, { ...check(), app: { id: 42 } }];
  await assert.rejects(actionsChecks(api, "acme/app", candidate, ["test"]), status(425));
  checks.push({ ...check("test", 2), status: "in_progress" });
  await assert.rejects(actionsChecks(api, "acme/app", candidate, ["test"]), status(425));
  checks.push(check("test", 3));
  assert.equal((await actionsChecks(api, "acme/app", candidate, ["test"]))[0].id, 3);
  assert.deepEqual(await actionsChecks(api, "acme/app", candidate, ["test"]), await actionsChecks(api, "acme/app", candidate, ["test"]), "reconciliation reads the same receipt without dispatch");
});

test("code failures are repairable but cancelled infrastructure requires attention", async () => {
  const current = check();
  const api = async () => ({ total_count: 1, check_runs: [current] });
  current.conclusion = "failure";
  assert.equal((await actionsChecks(api, "acme/app", candidate, ["test"]))[0].passed, false);
  for (const conclusion of ["cancelled", "timed_out", "action_required", "stale"]) {
    current.conclusion = conclusion;
    await assert.rejects(actionsChecks(api, "acme/app", candidate, ["test"]), status(422));
  }
});

test("preview receipts require Actions CI, its current-revision comment and matching live revision", async () => {
  const comment = { id: 4, user: { login: "github-actions[bot]" }, body: `<!-- app-previews -->\nRevision: \`${head}\`\n- [Chat](https://branch.ai-outfitter.dev)` };
  const api = async (path: string) => path.includes("check-runs") ? { total_count: 1, check_runs: [check("preview-links")] } : [comment];
  let revision = "b".repeat(40);
  const request = (async (url: string, init: RequestInit) => {
    assert.equal(url, "https://branch.ai-outfitter.dev/api/health");
    assert.equal(init.redirect, "manual");
    return Response.json({ status: "ok", revision });
  }) as typeof fetch;
  await assert.rejects(actionsPreview(api, "acme/app", candidate, request), status(425));
  revision = head;
  const receipt = await actionsPreview(api, "acme/app", candidate, request);
  assert.equal(receipt.headSha, head);
  assert.equal(receipt.commentId, 4);
  comment.user.login = "someone";
  await assert.rejects(actionsPreview(api, "acme/app", candidate, request), status(425));
  comment.user.login = "github-actions[bot]";
  comment.body = comment.body.replace(head, "b".repeat(40));
  await assert.rejects(actionsPreview(api, "acme/app", candidate, request), status(425));
});


test("CI waits and approved unchanged candidates use coordination without repeat agent sessions", () => {
  assert.equal(coordinatedRole({ ci: "actions", role: "validate" }), true);
  assert.equal(coordinatedRole({ ci: "actions", role: "land" }), true);
  assert.equal(coordinatedRole({ ci: "actions", role: "review" }, { passed: false }), true);
  assert.equal(coordinatedRole({ ci: "actions", role: "review" }, { passed: true }), false);
  assert.equal(coordinatedRole({ ci: "workspace", role: "validate" }), false);
  const approved = { passed: true, candidate: { headSha: head }, review: { verdict: "approved", headSha: head } };
  assert.equal(coordinatedRole({ ci: "actions", role: "repair" }, approved), true);
  assert.equal(coordinatedRole({ ci: "actions", role: "review" }, approved), true);
  for (const review of [{ verdict: "changes-requested", headSha: head }, { verdict: "approved", headSha: "b".repeat(40) }, null])
    assert.equal(coordinatedRole({ ci: "actions", role: "review" }, { ...approved, review }), false);
  assert.equal(coordinatedRole({ ci: "workspace", role: "review" }, approved), false);
  assert.equal(coordinatedRole({ ci: "actions", role: "repair" }, { ...approved, passed: false }), false);
  assert.equal(coordinatedRole({ ci: "actions", role: "repair" }, { ...approved, review: { verdict: "changes-requested", headSha: head } }), false);
  assert.equal(coordinatedRole({ ci: "actions", role: "repair" }, { ...approved, review: { verdict: "approved", headSha: "b".repeat(40) } }), false);
  assert.equal(workspaceCoordinatorPermissions({ ci: "actions", role: "validate", mergeQueue: true }).checks, "read");
});


test("trusted CI can select no preview for docs or a template-only preview for app changes", async () => {
  const comment = { id: 9, user: { login: "github-actions[bot]" }, body: `<!-- app-previews -->\nRevision: \`${head}\`\nNo application changes to preview.` };
  const api = async (path: string) => path.includes("check-runs") ? { total_count: 1, check_runs: [check("preview-links")] } : [comment];
  const noNetwork = (async () => { throw new Error("Docs must not request a preview"); }) as typeof fetch;
  assert.equal((await actionsPreview(api, "acme/app", candidate, noNetwork)).kind, "not-needed");
  comment.body = `<!-- app-previews -->\nRevision: \`${head}\`\n- [crm](https://crm-branch.ai-outfitter.dev)`;
  const request = (async (url: string) => {
    assert.equal(url, "https://crm-branch.ai-outfitter.dev/api/health");
    return Response.json({ status: "ok", revision: head });
  }) as typeof fetch;
  assert.equal((await actionsPreview(api, "acme/app", candidate, request)).verifiedUrl, "https://crm-branch.ai-outfitter.dev");
});

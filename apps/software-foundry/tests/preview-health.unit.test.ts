import assert from "node:assert/strict";
import test from "node:test";
import { actionsPreview, githubActionsAppId } from "../src/server/workspace/actions-ci";
import { gatewayPreviewRequest } from "../src/server/workspace/preview-health";

const url = "https://branch.ai-outfitter.dev";
const head = "a".repeat(40);

test("gateway health still requires trusted Actions publication and the inspected commit", async () => {
  const candidate = { number: 7, headSha: head, branch: "assigned", url: "https://github.com/acme/app/pull/7" };
  const api = async (path: string) => path.includes("check-runs") ? { total_count: 1, check_runs: [{
    id: 1, name: "preview-links", head_sha: head, app: { id: githubActionsAppId }, status: "completed", conclusion: "success",
  }] } : [{ id: 2, user: { login: "github-actions[bot]" }, body: `<!-- app-previews -->\nRevision: \`${head}\`\n- [Chat](${url})` }];
  let revision = "b".repeat(40);
  const request = gatewayPreviewRequest(async input => {
    assert.deepEqual(input, { operation: "inspect-preview", url });
    // The gateway's bounded health receipt for that origin.
    return { status: 200, health: { status: "ok", revision } };
  });
  await assert.rejects(actionsPreview(api, "acme/app", candidate, request), (error: unknown) => error instanceof Response && error.status === 425);
  revision = head;
  assert.equal((await actionsPreview(api, "acme/app", candidate, request)).headSha, head);
});

test("an older gateway delays verification during rollout without hiding authorization failures", async () => {
  const old = gatewayPreviewRequest(async () => { throw new Response("Invalid workspace node", { status: 400 }); });
  assert.equal((await old(`${url}/api/health`)).status, 503);
  for (const status of [401, 403, 500]) {
    const unavailable = gatewayPreviewRequest(async () => { throw new Response(null, { status }); });
    await assert.rejects(unavailable(`${url}/api/health`), (error: unknown) => error instanceof Response && error.status === status);
  }
});

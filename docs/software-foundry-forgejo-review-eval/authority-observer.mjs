import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";

if (process.argv[1] === "/app/workspace/gateway.mjs") {
  const fetchUpstream = globalThis.fetch;
  const origin = new URL(process.env.WORKFLOW_NODE_URL).origin;
  let first = true;
  globalThis.fetch = async (input, options) => {
    if (!(input instanceof URL) || input.pathname !== "/api/internal/workspace-review-authority")
      return fetchUpstream(input, options);
    assert.equal(input.origin, origin);
    assert.equal(options.method, "POST");
    assert.ok(process.env.WORKSPACE_GATEWAY_TOKEN);
    assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${process.env.WORKSPACE_GATEWAY_TOKEN}`);
    const authority = JSON.parse(options.body);
    const staleBinding = first && process.env.FOUNDRY_REVIEW_CASE === "authority-retry";
    first = false;
    const request = staleBinding
      ? { ...options, body: JSON.stringify({ ...authority, bindingRevision: `${authority.bindingRevision}-stale` }) }
      : options;
    const response = await fetchUpstream(input, request);
    const reviewPosts = readFileSync("/out/forgejo-requests.jsonl", "utf8").trim().split("\n").map(JSON.parse)
      .filter(entry => entry.method === "POST" && /\/pulls\/\d+\/reviews$/.test(entry.path)).length;
    appendFileSync("/out/review-authority.jsonl", JSON.stringify({
      origin, path: input.pathname, authenticated: true, staleBinding, status: response.status, reviewPosts,
      runId: authority.runId, attemptId: authority.attemptId, repository: authority.repository, repositoryId: authority.repositoryId,
    }) + "\n");
    return response;
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { issueBody, parseRequest, requestMarker, submitRequest } from "../box/intake.mjs";

const request = {
  schemaVersion: 1,
  requestId: "3A7E9C1D-5B2F-4E8A-9D6C-1F0B2A3C4D5E",
  kind: "feature",
  title: "Add a subtract helper",
  problem: "There is no subtract.",
  acceptanceCriteria: [{ id: "export-subtract", text: "index.mjs exports subtract(a, b)." }],
};

test("a work request is checked and rendered as an issue with its criteria and marker", () => {
  const parsed = parseRequest(request);
  assert.equal(parsed.requestId, "3a7e9c1d-5b2f-4e8a-9d6c-1f0b2a3c4d5e");
  assert.equal(parsed.delivery, "pull_request");
  const body = issueBody(parsed);
  assert.match(body, /- \[ \] `export-subtract`: index\.mjs exports subtract/);
  assert.ok(body.endsWith(requestMarker(parsed.requestId)));
  assert.throws(() => parseRequest({ ...request, kind: "bug" }), /bug details/);
  assert.throws(() => parseRequest({ ...request, acceptanceCriteria: [] }), /acceptanceCriteria/);
  assert.throws(() => parseRequest({ ...request, requestId: "x" }), /UUID/);
  const bug = parseRequest({ ...request, kind: "bug", bug: { stepsToReproduce: ["Call subtract"], expected: "2", actual: "error" } });
  assert.match(issueBody(bug), /## Steps to reproduce\n\n1\. Call subtract/);
});

test("intake files one issue per request and starts Foundry on it", async () => {
  const issues: { number: number; body: string; html_url: string }[] = [];
  const started: unknown[] = [];
  const forgejo = async (method: string, path: string, body?: { title: string; body: string }) => {
    if (method === "GET" && path.startsWith("/repos/box/repo/issues?")) return [...issues].reverse();
    if (method === "POST" && path === "/repos/box/repo/issues" && body) {
      const issue = { number: issues.length + 1, body: body.body, html_url: `i${issues.length + 1}` };
      issues.push(issue);
      return issue;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const operator = async (input: unknown) => {
    started.push(input);
    return { id: "run-1", status: "running" };
  };
  const parsed = parseRequest(request);
  const first = await submitRequest(parsed, { forgejo, operator, repository: "box/repo" });
  const again = await submitRequest(parsed, { forgejo, operator, repository: "box/repo" });
  assert.deepEqual(first.issue, { number: 1, url: "i1", created: true });
  assert.deepEqual(again.issue, { number: 1, url: "i1", created: false });
  assert.equal(issues.length, 1);
  assert.deepEqual(started, [
    { operation: "start", repository: "box/repo", number: 1 },
    { operation: "start", repository: "box/repo", number: 1 },
  ]);
});

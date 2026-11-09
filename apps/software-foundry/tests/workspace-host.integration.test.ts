import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { migrateAppDatabase } from "@ai-outfitter/app-sdk/migrations";
import { identityHeaderValues } from "@ai-outfitter/app-sdk/server";
import { type finalizeInput, type prepareInput, workflowHostPath } from "@ai-outfitter/app-sdk/workflow-host";
import { Miniflare } from "miniflare";
import type { z } from "zod";

const head = "a".repeat(40);
const runId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const node = { runId, nodeId: "triage", attemptId };
const event = { action: "opened", repository: { id: 1, full_name: "acme/app" }, issue: { number: 3, title: "Split cents" } };
const settings = (role: string) => ({
  role, ci: "actions", reviewer: "atlas", mergeQueue: false, checks: [{ name: "test", commands: [["npm", "test"]] }],
});
// A 1x1 PNG.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** The built Worker behind real workerd RPC dispatch props, with its own D1
 * database and `runs` bucket. The host double answers GitHub through
 * `repository.request` as the platform would and records every call. */
async function installed(workflowId = "issue-to-merge-actions-ci") {
  const pack = JSON.parse(await readFile(appArtifact(new URL("../", import.meta.url), "operational"), "utf8"));
  const source = `
import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./${pack.artifact.mainModule}";
const calls = [];
const issue = { number: 3, title: "Split cents", html_url: "https://github.com/acme/app/issues/3", state: "open", body: "" };
const pull = { user: { id: 10 }, number: 7, state: "open", html_url: "https://github.com/acme/app/pull/7",
  head: { sha: "${head}", ref: "outfitter/issue-3-${runId}", repo: { full_name: "acme/app" } },
  base: { ref: "main", repo: { full_name: "acme/app" } } };
function answer(operation, input) {
  if (operation === "repository.read") return { name: "acme/app", path: "/repos/acme/app", repositoryId: 1, installationId: 101, appId: 42 };
  if (operation === "workflow.read") return { run: { id: "${runId}", workflowId: "${workflowId}", status: "running", createdBy: "owner", createdAt: 1, updatedAt: 1 },
    inputs: { "triage.inputs.event": ${JSON.stringify(event)} }, outputs: {}, readiness: { run: "running", steps: {} },
    attempts: [{ id: "${attemptId}", nodeId: "implement", state: "running", createdAt: 1, updatedAt: 1 }] };
  if (operation === "workspace.control") return { ready: true };
  if (operation !== "repository.request") return undefined;
  if (input.path === "/repos/acme/app/issues/3") return issue;
  if (input.path === "/repos/acme/app/issues/3/comments?per_page=100") return [];
  if (input.path === "/repos/acme/app/issues/3/comments" && input.method === "POST") return { id: 9, html_url: "https://github.com/acme/app/issues/3#issuecomment-9" };
  if (input.path === "/repos/acme/app/pulls/7") return pull;
  if (input.path === "/repos/acme/app/pulls/7/reviews?per_page=100")
    return [{ id: 11, state: "APPROVED", commit_id: "${head}", user: { id: 20 } }];
  if (input.path === "/repos/acme/app/pulls/7/files?per_page=100&page=1") return [{ filename: "src/split.js", status: "modified" }];
  if (input.path === "/repos/acme/app") return { default_branch: "main" };
  if (input.path === "/repos/acme/app/commits/${head}/check-runs?per_page=100")
    return { total_count: 1, check_runs: [{ id: 1, name: "test", head_sha: "${head}", app: { id: 15368 }, status: "completed", conclusion: "success", html_url: "https://github.com/acme/app/actions/runs/1" }] };
  if (input.path === "/graphql" && input.method === "POST")
    return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 3, repository: { nameWithOwner: "acme/app" } }] } } } } };
  return undefined;
}
export class Host extends WorkerEntrypoint {
  async call(operation, input) {
    calls.push({ operation, input, phase: this.ctx.props.phase });
    const value = answer(operation, input);
    return value === undefined ? { ok: false, status: 403, message: "Fixture operation denied" } : { ok: true, value };
  }
}
export class Installed extends WorkerEntrypoint { async fetch(request) { return app.fetch(request, this.env, this.ctx); } }
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__calls") return Response.json(calls.splice(0));
    if (request.headers.has("x-test-no-host")) return app.fetch(request, env, ctx);
    const host = ctx.exports.Host({ props: { phase: request.headers.get("x-test-phase") } });
    return ctx.exports.Installed({ props: { workflowHost: host } }).fetch(request);
  },
};`;
  const modules = Object.fromEntries(Object.entries(pack.artifact.modules).map(([name, contents]) =>
    [name, { type: "esm" as const, contents: contents as string }]));
  const worker = new Miniflare({
    workers: [{
      config: {
        name: "software-foundry",
        compatibilityDate: pack.artifact.compatibilityDate,
        compatibilityFlags: pack.artifact.compatibilityFlags,
        manifest: { mainModule: "rpc-fixture.mjs", modulesRoot: "/", modules: { ...modules, "rpc-fixture.mjs": { type: "esm", contents: source } } },
        env: { DB: { type: "d1", id: "foundry-db" }, STORAGE_MAIN: { type: "r2", name: "foundry-main" } },
      },
    }],
  });
  const database = await worker.getD1Database("DB");
  await migrateAppDatabase({
    query: async (statement) => (await database.prepare(statement).all<Record<string, unknown>>()).results,
    batch: async (statements) => { await database.batch(statements.map((statement) => database.prepare(statement))); },
  }, pack.manifest.database.migrations);
  const phase = (name: string, input: unknown, headers: Record<string, string> = {}) =>
    worker.dispatchFetch(`https://software-foundry.example${workflowHostPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "x-test-phase": name, ...headers,
        ...identityHeaderValues({ userId: "owner", organizationId: "org", installationId: "foundry", role: "owner" }),
      },
      body: JSON.stringify({ phase: name, input }),
    }) as unknown as Promise<Response>;
  const calls = async () => (await (await worker.dispatchFetch("https://software-foundry.example/__calls")).json()) as
    { operation: string; input: Record<string, unknown> }[];
  return { worker, phase, calls };
}

test("screenshots publish from either issue-to-merge workflow, and from no other", async () => {
  for (const workflowId of ["issue-to-merge-workspace", "issue-to-review"]) {
    const { worker, phase } = await installed(workflowId);
    try {
      const published = await phase("publish", { node: { ...node, nodeId: "implement" }, number: 7, headSha: head, filename: "desktop.png", base64: png });
      assert.equal(published.status, workflowId === "issue-to-review" ? 404 : 200, `${workflowId}: ${await published.clone().text()}`);
    } finally {
      await worker.dispose();
    }
  }
});

test("Foundry's workspace policy runs over the platform's real prepare, finalize and publish payloads", async () => {
  const { worker, phase, calls } = await installed();
  try {
    // prepare: an implementation agent task; a coordinated validation needs no session.
    const prepare: z.input<typeof prepareInput> = { node, inputs: { event }, outputs: { result: { type: "object" } }, settings: settings("implement") };
    const agent = await phase("prepare", prepare);
    assert.equal(agent.status, 200, await agent.clone().text());
    const task = await agent.json() as { mode: string; role: string; checks: unknown[]; guidance: string[] };
    assert.equal(task.mode, "agent");
    assert.equal(task.role, "implement");
    assert.ok(task.guidance.some((line) => line.includes("PR Demo")));
    assert.deepEqual(await (await phase("prepare", { ...prepare, settings: settings("validate") })).json(), { mode: "coordinator" });

    // finalize: triage reads the issue from the node's explicit `inputs`, then comments once.
    await calls();
    const finalize: z.input<typeof finalizeInput> = {
      node, inputs: { event }, outputs: { result: { ready: true, summary: "Plan: preserve every cent" } },
      coordinator: false, session: { artifact: { id: "archive" } }, settings: settings("triage"),
    };
    const finalized = await phase("finalize", finalize);
    assert.equal(finalized.status, 200, await finalized.clone().text());
    const { outputs } = await finalized.json() as { outputs: { result: Record<string, any> } };
    assert.equal(outputs.result.issue.number, 3);
    assert.deepEqual(outputs.result.comment, { id: 9, url: "https://github.com/acme/app/issues/3#issuecomment-9" });
    assert.deepEqual(outputs.result.sessionArtifact, { id: "archive" });
    const comment = (await calls()).find((call) => call.input.method === "POST");
    assert.ok(comment, "the triage comment was posted");
    assert.match(String((comment.input.body as { body: string }).body), /Plan: preserve every cent/);

    // publish: the PR closes the run's issue (read-only GraphQL with method and body),
    // then the screenshot is stored publicly in the installation's own bucket.
    const published = await phase("publish", { node: { ...node, nodeId: "implement" }, number: 7, headSha: head, filename: "desktop.png", base64: png });
    assert.equal(published.status, 200, await published.clone().text());
    const receipt = await published.json() as { url: string; headSha: string; filename: string; width: number; height: number };
    assert.equal(receipt.headSha, head);
    assert.deepEqual({ width: receipt.width, height: receipt.height }, { width: 1, height: 1 });
    assert.match(receipt.url, new RegExp(`^https://software-foundry\\.example/files/main/runs/${runId}/demo-${head}-[a-f0-9]{16}-desktop\\.png$`));
    const linkage = (await calls()).find((call) => call.input.path === "/graphql");
    assert.ok(linkage, "the linkage query ran");
    assert.equal(linkage.input.method, "POST");
    assert.match(String((linkage.input.body as { query: string }).query), /closingIssuesReferences/);
    const file = await worker.dispatchFetch(receipt.url);
    assert.equal(file.status, 200, "published evidence is public");
    assert.equal(file.headers.get("content-type"), "image/png");

    // Approval needs no repair session. The coordinator still reads the PR and
    // demo receipts, preserving the inspected commit and formal review.
    const previous = { ready: true, summary: "Reviewed", passed: true,
      candidate: { number: 7, headSha: head, branch: `outfitter/issue-3-${runId}`, url: "https://github.com/acme/app/pull/7" },
      review: { verdict: "approved", headSha: head, id: 11, reviewer: { id: 20, login: "atlas" } } };
    assert.deepEqual(await (await phase("prepare", { ...prepare, inputs: { event, previous }, settings: settings("repair") })).json(), { mode: "coordinator" });
    const repaired = await phase("finalize", { node: { ...node, nodeId: "repair" }, inputs: { event, previous },
      outputs: {}, coordinator: true, session: {}, settings: settings("repair") });
    assert.equal(repaired.status, 200, await repaired.clone().text());
    const repair = (await repaired.json() as { outputs: { result: Record<string, any> } }).outputs.result;
    assert.equal(repair.candidate.headSha, head);
    assert.deepEqual(repair.review, previous.review);
    assert.equal(repair.passed, true);
    assert.equal(repair.repair.status, "skipped");
    assert.match(repair.summary, /no review findings/);
    assert.equal(repair.sessionArtifact, undefined);
    assert.deepEqual({ width: repair.evidence[0].width, height: repair.evidence[0].height }, { width: 1, height: 1 });
    const validated = await phase("finalize", { node: { ...node, nodeId: "validate-final" },
      inputs: { event, previous: { ...previous, demo: { status: "needs-attention", missing: ["mobile"] } } },
      outputs: {}, coordinator: true, session: {}, settings: settings("validate") });
    assert.equal(validated.status, 200, await validated.clone().text());
    const validation = (await validated.json() as { outputs: { result: Record<string, any> } }).outputs.result;
    assert.equal(validation.passed, true);
    assert.equal(validation.demo.status, "not-required", "validation refreshes the stale Demo flag against the current source/PR");
    assert.deepEqual({ width: validation.evidence[0].width, height: validation.evidence[0].height }, { width: 1, height: 1 });

    // The unchanged, freshly validated candidate reuses the exact formal approval:
    // no reviewer preflight/session or publish-review operation is dispatched.
    await calls();
    assert.deepEqual(await (await phase("prepare", { ...prepare, node: { ...node, nodeId: "review-final" },
      inputs: { event, previous: validation }, settings: settings("review") })).json(), { mode: "coordinator" });
    const reused = await phase("finalize", { node: { ...node, nodeId: "review-final" },
      inputs: { event, previous: validation }, outputs: {}, coordinator: true, session: {}, settings: settings("review") });
    assert.equal(reused.status, 200, await reused.clone().text());
    const result = (await reused.json() as { outputs: { result: Record<string, any> } }).outputs.result;
    assert.deepEqual(result.review, previous.review);
    assert.deepEqual(result.reviewReuse, { status: "reused", reviewId: 11, headSha: head });
    assert.equal(result.sessionArtifact, undefined);
    const reuseCalls = await calls();
    assert.ok(reuseCalls.some(call => call.input.path === "/repos/acme/app/pulls/7/reviews?per_page=100"));
    assert.ok(!reuseCalls.some(call => call.operation === "workspace.control"));
    assert.ok(!reuseCalls.some(call => call.input.method && call.input.method !== "GET" && call.input.path !== "/graphql"));

    assert.equal((await phase("prepare", prepare, { "x-test-no-host": "1" })).status, 503,
      "forwarded identity alone cannot manufacture a host capability");
  } finally {
    await worker.dispose();
  }
});

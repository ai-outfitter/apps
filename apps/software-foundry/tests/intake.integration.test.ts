import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { migrateAppDatabase } from "@ai-outfitter/app-sdk/migrations";
import { type AppActor, encodeActor, identityHeaderValues, identityHeaders } from "@ai-outfitter/app-sdk/server";
import { workflowHostPath } from "@ai-outfitter/app-sdk/workflow-host";
import { Miniflare } from "miniflare";
import { bodyLimit, intakeComment, intakeIssueBody, submitInput, workPackageDigest } from "../src/server/intake";

// The built Foundry Worker behind real workerd RPC dispatch props. Requests carry
// the headers the platform's app dispatch sets for an MCP client or an app. The
// host double answers the platform operations Foundry uses as the platform does
// where it matters here: editor-only operations refuse members, connector
// operations run only on the subscription's connection resource while the
// platform derives access to them (\`operations\` stands in for the manifest
// and current connection), and a run ID is claimed once — a
// repeated start with different inputs or another creator is refused.
const fixtureSource = (mainModule: string) => `
import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./${mainModule}";
const issue = (number, extra = {}) => ({ number, title: "Issue " + number, html_url: "https://github.com/acme/app/issues/" + number, state: "open", body: "", ...extra });
const state = { pullMerged: true, clock: 0, calls: [], bindingHash: "hash", subscriptionEnabled: true, startFailure: false, operations: ["issues.create", "issues.comment"], comments: new Map(), runs: [],
  issues: new Map([[3, issue(3)], [4, issue(4, { state: "closed" })], [5, issue(5, { html_url: "https://github.com/acme/app/pull/5", pull_request: {} })]]) };
const inputs = { "triage.inputs.triagerBinding": "b-triager", "triage.inputs.engineerBinding": "b-engineer", "triage.inputs.reviewerBinding": "b-reviewer", "triage.inputs.landerBinding": "b-lander" };
const denied = (status, message) => ({ denied: { ok: false, status, message } });
const editorOnly = new Set(["snapshot", "connector.execute", "workflow.start"]);
function connector(input) {
  if (input.connectionId !== "github" || input.resource !== "1" || !state.operations.includes(input.operation)) return denied(403, "Connector access unavailable");
  const tag = "<!-- outfitter-request:" + String(input.input.marker).toLowerCase() + " -->";
  if (input.operation === "issues.create") {
    const found = [...state.issues.values()].find((item) => item.body.includes(tag));
    if (found) return { number: found.number, url: found.html_url, state: found.state, created: false };
    const created = issue(10 + state.issues.size, { title: input.input.title, body: input.input.body + "\\n\\n" + tag });
    state.issues.set(created.number, created);
    return { number: created.number, url: created.html_url, state: "open", created: true };
  }
  const target = state.issues.get(input.input.number);
  if (!target || target.pull_request) return denied(409, "Issue comment cannot target a pull request");
  const comments = state.comments.get(target.number) ?? [];
  const found = comments.find((item) => item.body.includes(tag));
  if (found) return { ...found, created: false };
  const created = { id: 100 + comments.length, html_url: target.html_url + "#comment", body: input.input.body + "\\n\\n" + tag };
  state.comments.set(target.number, [...comments, created]);
  return { ...created, created: true };
}
function answer(operation, input, props) {
  if (editorOnly.has(operation) && !/owner|admin/.test(props.role)) return denied(403, "Workflow host authority unavailable");
  if (operation === "snapshot") return {
    installation: { id: "foundry", activeHash: "hash", hostname: "foundry.acme.localhost", workflows: ["issue-to-merge-actions-ci"] },
    bindings: Object.values(inputs).map((id) => ({ id, workflowId: "issue-to-merge-actions-ci", actor: id.slice(2), kind: "external", label: id, revision: "r", packageHash: state.bindingHash, enabled: true })),
    subscriptions: [{ id: "sub", workflowId: "issue-to-merge-actions-ci", connectionId: "github", resource: "1", enabled: state.subscriptionEnabled, inputs }],
    connections: [{ id: "github", provider: "github", revision: "r", owner: "organization", operations: state.operations, repositories: ["acme/app"] }],
  };
  if (operation === "connector.receipts") return Array.from({length:state.receiptCount ?? 0},(_,i)=>({deliveryId:"delivery-"+i,provider:"github",receivedAt:1,status:"accepted"}));
  if (operation === "artifacts.published") return Array.from({length:state.imageCount ?? 0},(_,i)=>({id:"image-"+i,runId:input.runId,name:"image-"+i,contentType:"image/png",createdAt:1,revision:null,url:"https://example.test/image/"+i}));
  if (operation === "repository.read") return { name: "acme/app", path: "/repos/acme/app", repositoryId: 1, installationId: 101, appId: 42 };
  if (operation === "repository.request") {
    if (input.path === "/graphql" && input.bindingId) return denied(403,"Action phase binding GraphQL denied");
    const commentsMatch = /^\\/repos\\/acme\\/app\\/issues\\/(\\d+)\\/comments/.exec(input.path);
    if (commentsMatch) return state.comments.get(Number(commentsMatch[1])) ?? [];
    if (input.path.startsWith("/repos/acme/app/issues?")) return [...state.issues.values()];
    if (input.path === "/graphql") return {data:{repository:{pullRequest:{closingIssuesReferences:{nodes:[{number:13,repository:{nameWithOwner:"acme/app"}}]}}}}};
    if (input.path === "/repos/acme/app/pulls/22") return {number:22,html_url:"https://github.com/acme/app/pull/22",head:{sha:"a".repeat(40)},base:{repo:{full_name:"acme/app"}},merged:state.pullMerged,merge_commit_sha:"b".repeat(40),state:"closed"};
    if (input.path.includes("/pulls/22/reviews")) return [...(state.nullReview ? [{id:2,commit_id:null,state:"APPROVED"}] : []),{id:1,commit_id:"a".repeat(40),state:"APPROVED"}];
    if (input.path.includes("/check-runs?")) return {check_runs:[{head_sha:"a".repeat(40),conclusion:"success"}]};
    if (input.path === "/repos/acme/app") return { id: 1, full_name: "acme/app" };
    const match = /^\\/repos\\/acme\\/app\\/issues\\/(\\d+)$/.exec(input.path);
    return match && state.issues.get(Number(match[1]));
  }
  if (operation === "connector.execute") return connector(input);
  // As the platform: newest first, at most limitPerSubject references.
  if (operation === "workflow.references") return state.runs.filter((run) => input.subjects.includes(run.subject))
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, input.limitPerSubject ?? 10)
    .map(({ id, subject, status, updatedAt }) => ({ id, key: "1", subject, label: "", status, updatedAt }));
  // One of this installation's runs by ID, or null (foreign and missing look the same).
  if (operation === "workflow.read") {
    const run = state.runs.find((item) => item.id === input.id && !item.foreign);
    return run ? { run: { id: run.id, workflowId: run.workflow, status: run.status, createdBy: run.createdBy, createdAt: 1, updatedAt: run.updatedAt },
      inputs: {}, outputs: run.outputs ?? {}, readiness: { run: run.status, steps: {} }, attempts: [] } : { none: true };
  }
  if (operation === "workflow.start") {
    if (state.startFailure) return denied(503, "Workflow executor unavailable");
    // As claimRun: one run per ID; only the identical request by the same creator replays it.
    const prior = state.runs.find((run) => run.id === input.id);
    const request = JSON.stringify([input.workflow, input.inputs]);
    if (prior) return prior.request === request && prior.createdBy === props.user ? { id: input.id, workflow: input.workflow, created: false } : denied(409, "Run ID already claimed with different inputs");
    state.runs.unshift({ id: input.id, workflow: input.workflow, subject: input.inputs["triage.inputs.event"].issue.number, status: "running", request, createdBy: props.user, updatedAt: ++state.clock });
    return { id: input.id, workflow: input.workflow, created: true };
  }
  return undefined;
}
export class Host extends WorkerEntrypoint {
  async call(operation, input) {
    state.calls.push({ operation, input, phase: this.ctx.props.phase, user: this.ctx.props.user });
    const value = answer(operation, input, this.ctx.props);
    if (operation === "connector.execute" && state.failAfterCreate) { state.failAfterCreate = false; return {ok:false,status:state.failAfterStatus,message:"Response interrupted after provider write"}; }
    if (value === undefined || value === null) return { ok: false, status: 403, message: "Fixture operation denied" };
    if (value.none) return { ok: true, value: null };
    return value.denied ?? { ok: true, value };
  }
}
export class Installed extends WorkerEntrypoint { async fetch(request) { return app.fetch(request, this.env, this.ctx); } }
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__calls") return Response.json(state.calls.splice(0));
    if (url.pathname === "/__state") {
      if (request.method === "GET") return Response.json({ issues: Object.fromEntries(state.issues), comments: Object.fromEntries(state.comments), runs: state.runs });
      const change = await request.json();
      for (const field of ["failAfterCreate","failAfterStatus","pullMerged","receiptCount","imageCount","nullReview"]) if (change[field] !== undefined) state[field] = change[field];
      if (change.failAfterCreate && change.failAfterStatus === undefined) state.failAfterStatus = 502;
      if (change.issueState) state.issues.get(change.issueState.number).state = change.issueState.state;
      if (change.clearIssueBody) state.issues.get(change.clearIssueBody).body = "";
      if (change.bindingHash) state.bindingHash = change.bindingHash;
      if (change.subscriptionEnabled !== undefined) state.subscriptionEnabled = change.subscriptionEnabled;
      if (change.startFailure !== undefined) state.startFailure = change.startFailure;
      if (change.operations) state.operations = change.operations;
      if (change.issueTitle) state.issues.get(change.issueTitle.number).title = change.issueTitle.title;
      if (change.runOutputs) state.runs.find((run) => run.id === change.runOutputs.id).outputs = change.runOutputs.outputs;
      if (change.runStatus) Object.assign(state.runs.find((run) => run.id === change.runStatus.id), { status: change.runStatus.status, updatedAt: ++state.clock });
      for (const run of change.addRun ? [change.addRun] : change.addRuns ?? [])
        state.runs.unshift({ workflow: "foundry-land-reviewed-change", ...run, request: "operator", createdBy: "operator", updatedAt: ++state.clock });
      if (change.removeRun) state.runs = state.runs.filter((run) => run.id !== change.removeRun);
      return new Response(null, { status: 204 });
    }
    const props = { phase: request.headers.get("x-test-phase") ?? "interactive", user: request.headers.get("x-outfitter-user"), role: request.headers.get("x-outfitter-role") };
    return ctx.exports.Installed({ props: { workflowHost: ctx.exports.Host({ props }) } }).fetch(request);
  },
};`;

type Options = { method?: string; userId?: string; role?: string; actor?: AppActor; originActor?: AppActor; body?: unknown; phase?: string };
type State = { issues: Record<string, { number: number; title: string; body: string }>; comments: Record<string, { id: number; body: string }[]>; runs: { id: string; status: string; createdBy: string }[] };

async function installed() {
  const pack = JSON.parse(await readFile(appArtifact(new URL("../", import.meta.url), "operational"), "utf8"));
  const modules = Object.fromEntries(Object.entries(pack.artifact.modules).map(([name, contents]) =>
    [name, { type: "esm" as const, contents: contents as string }]));
  const worker = new Miniflare({
    workers: [{
      config: {
        name: "software-foundry",
        compatibilityDate: pack.artifact.compatibilityDate,
        compatibilityFlags: pack.artifact.compatibilityFlags,
        manifest: { mainModule: "rpc-fixture.mjs", modulesRoot: "/", modules: { ...modules, "rpc-fixture.mjs": { type: "esm", contents: fixtureSource(pack.artifact.mainModule) } } },
        env: { DB: { type: "d1", id: "foundry-db" }, STORAGE_MAIN: { type: "r2", name: "foundry-main" } },
      },
    }],
  });
  const database = await worker.getD1Database("DB");
  await migrateAppDatabase({
    query: async (statement) => (await database.prepare(statement).all<Record<string, unknown>>()).results,
    batch: async (statements) => { await database.batch(statements.map((statement) => database.prepare(statement))); },
  }, pack.manifest.database.migrations);
  const origin = "https://software-foundry.example";
  /** A request as the platform's app dispatch sends it: identity plus verified callers. */
  const dispatch = (path: string, { userId = "owner", role = "owner", actor, originActor, body, phase, method }: Options = {}) =>
    worker.dispatchFetch(`${origin}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        ...identityHeaderValues({ userId, organizationId: "org", installationId: "foundry", role }),
        ...(actor ? { [identityHeaders.actor]: encodeActor(actor) } : {}),
        ...(originActor ? { [identityHeaders.originActor]: encodeActor(originActor) } : {}),
        ...(phase ? { "x-test-phase": phase } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as unknown as Promise<Response>;
  const action = async (input: unknown, options: Options = {}) => {
    const response = await dispatch("/api/internal/actions/v1/call", { actor: codex, originActor: codex, ...options, body: { action: "work.submit", input } });
    return { status: response.status, body: response.ok ? await response.json() as Record<string, any> : await response.text() };
  };
  const calls = async () => (await (await worker.dispatchFetch(`${origin}/__calls`)).json()) as { operation: string; input: Record<string, any> }[];
  const state = async () => (await (await worker.dispatchFetch(`${origin}/__state`)).json()) as State;
  const change = (value: Record<string, unknown>) => worker.dispatchFetch(`${origin}/__state`, { method: "POST", body: JSON.stringify(value) });
  /** A signed issue delivery as the platform hands it to the event phase. */
  const webhook = async (number: number, runId: string) => {
    const response = await dispatch(workflowHostPath, { phase: "event", body: { phase: "event", input: {
      runId, deliveryId: `delivery-${runId}`,
      subscription: { id: "sub", workflowId: "issue-to-merge-actions-ci", inputs: {} },
      trigger: { event: "github.issue", input: "triage.inputs.event" },
      event: { type: "github.issue", resource: "1", subject: String(number), payload: { action: "opened", repository: { id: 1, full_name: "acme/app" }, issue: { number, title: `Issue ${number}` } } },
    } } });
    assert.equal(response.status, 200, await response.clone().text());
    return ((await response.json()) as { outcome: string }).outcome;
  };
  return { worker, dispatch, action, calls, state, change, webhook };
}

const codex: AppActor = { kind: "oauth-client", id: "codex-client", label: "Codex" };
const requestId = "aaaaaaaa-1111-4111-8111-111111111111";
const submission = (extra: Record<string, unknown> = {}) => ({
  target: { repository: "acme/app" }, requestId, title: "Add CSV export",
  description: "Admins export monthly reports.", acceptanceCriteria: ["Admins can download a CSV", "Totals match the report"],
  context: [{ installationId: "wiki", type: "use-case", id: "export-reports", title: "Export reports" }], ...extra,
});
const starts = (calls: { operation: string }[]) => calls.filter((call) => call.operation === "workflow.start").length;
const writes = (calls: { operation: string }[]) => calls.filter((call) => ["connector.execute", "workflow.start"].includes(call.operation)).length;

test("stale or missing execution setup preserves the issue receipt and retries resume once configured", async () => {
  const f = await installed();
  try {
    await f.change({ bindingHash: "previous-package" });
    const first = await f.action(submission());
    assert.equal(first.status, 200, String(first.body));
    const receipt = first.body as Record<string, any>;
    assert.equal(receipt.issue.created, true);
    assert.equal(receipt.run, null);
    assert.equal(receipt.execution.status, "blocked");
    assert.match(receipt.execution.message, /active package/);
    const calls = await f.calls();
    assert.equal(calls.some((call) => call.operation === "repository.read"), false, "a stale executable binding is never used to authorize submission");
    assert.equal(starts(calls), 0);
    await f.change({ bindingHash: "hash", subscriptionEnabled: false });
    const disabled = (await f.action(submission())).body as Record<string, any>;
    assert.equal(disabled.issue.number, receipt.issue.number);
    assert.equal(disabled.issue.created, false);
    assert.equal(disabled.execution.status, "blocked");
    await f.change({ subscriptionEnabled: true });
    const configured = (await f.action(submission())).body as Record<string, any>;
    assert.equal(configured.issue.number, receipt.issue.number);
    assert.equal(configured.issue.created, false);
    assert.equal(configured.run.status, "running");
    assert.equal(starts(await f.calls()), 1);
    await f.change({ bindingHash: "previous-package" });
    const upgraded = (await f.action(submission())).body as Record<string, any>;
    assert.equal(upgraded.run.id, configured.run.id, "a package upgrade does not hide the run already started for this issue");
    assert.equal(upgraded.run.existing, true);
    assert.equal(starts(await f.calls()), 0);
  } finally { await f.worker.dispose(); }
});

test("a workflow failure after issue creation returns the known issue and explicit uncertainty", async () => {
  const f = await installed();
  try {
    await f.change({ startFailure: true });
    const first = await f.action(submission());
    assert.equal(first.status, 200, String(first.body));
    const receipt = first.body as Record<string, any>;
    assert.equal(receipt.issue.created, true);
    assert.equal(receipt.run, null);
    assert.equal(receipt.execution.status, "outcome-unknown");
    assert.match(receipt.execution.message, /503.*Workflow executor unavailable/);
    await f.change({ startFailure: false });
    const retry = (await f.action(submission())).body as Record<string, any>;
    assert.equal(retry.issue.number, receipt.issue.number);
    assert.equal(retry.issue.created, false);
    assert.equal(retry.run.status, "running");
  } finally { await f.worker.dispose(); }
});

test("submitted work creates one issue and starts the canonical workflow once; retries converge", async () => {
  const f = await installed();
  try {
    // Discovery lists the intake Planning calls, evidence.publish and the graph actions.
    const listed = await (await f.dispatch("/api/internal/actions/v1/list", { actor: codex, originActor: codex })).json() as { name: string; access: string; permitted: boolean }[];
    assert.deepEqual(listed.map((a) => [a.name, a.access, a.permitted]), [["work.readiness", "read", true], ["work.targets", "read", true], ["work.get", "read", true], ["work.submit", "write", true], ["evidence.publish", "write", true], ["graph.graphql", "read", true], ["graph.mutate", "write", true]]);
    await f.calls();

    const first = await f.action(submission({ requestId: requestId.toUpperCase() }));
    assert.equal(first.status, 200, String(first.body));
    const result = first.body as Record<string, any>;
    assert.equal(result.issue.created, true);
    assert.equal(result.run.existing, false);
    assert.equal(result.run.status, "running");
    assert.equal(result.run.url, `https://software-foundry.example/workflows?workflow=issue-to-merge-actions-ci&run=${result.run.id}`);
    const calls = await f.calls();
    assert.equal(calls.filter((call) => call.operation === "connector.execute")[0].input.input.marker, `request:${requestId}`, "legacy markers survive deployment retries");
    // The canonical workflow starts once with the subscription's approved bindings:
    // the same triage, implementation, independent review and landing roles.
    const [start] = calls.filter((call) => call.operation === "workflow.start");
    assert.equal(starts(calls), 1);
    assert.equal(start.input.workflow, "issue-to-merge-actions-ci");
    assert.equal(start.input.inputs["triage.inputs.reviewerBinding"], "b-reviewer");
    assert.equal(start.input.inputs["triage.inputs.landerBinding"], "b-lander");
    // The issue carries the work and attribution from the verified callers only.
    const body = (await f.state()).issues[result.issue.number].body;
    assert.match(body, /- \[ \] Admins can download a CSV/);
    assert.match(body, /Export reports \(`use-case:export-reports` in installation `wiki`\)/);
    assert.match(body, /for user `owner` by oauth-client `codex-client` \(`Codex`\)\./);

    // A lower-case retry after the issue's title changed finds the marked issue and
    // returns the deterministic run without resubmitting its now-different inputs.
    await f.change({ issueTitle: { number: result.issue.number, title: "Renamed by a maintainer" } });
    const retry = await f.action(submission());
    assert.equal(retry.status, 200, String(retry.body));
    assert.deepEqual([(retry.body as Record<string, any>).issue.number, (retry.body as Record<string, any>).issue.created], [result.issue.number, false]);
    assert.deepEqual([(retry.body as Record<string, any>).run.id, (retry.body as Record<string, any>).run.existing], [result.run.id, true]);
    assert.equal(starts(await f.calls()), 0);

    // The issue's own signed webhook converges on that run instead of starting another.
    assert.equal(await f.webhook(result.issue.number, "33333333-3333-4333-8333-333333333333"), "declined");
    assert.equal(starts(await f.calls()), 0);

    // Another authenticated member attaching the same issue records the request
    // but never re-claims the run as its creator.
    const other = await f.action(submission({ requestId: "bbbbbbbb-1111-4111-8111-111111111111", issue: result.issue.number }), { userId: "other-owner" });
    assert.equal(other.status, 200, String(other.body));
    assert.deepEqual([(other.body as Record<string, any>).run.id, (other.body as Record<string, any>).run.existing], [result.run.id, true]);
    assert.match((await f.state()).comments[result.issue.number][0].body, /for user `other-owner`/);
    assert.equal(starts(await f.calls()), 0);

    // An operator's running resume is preferred over the failed deterministic run.
    const resumed = "55555555-5555-4555-8555-555555555555";
    await f.change({ runStatus: { id: result.run.id, status: "failed" }, addRun: { id: resumed, subject: result.issue.number, status: "running" } });
    const active = await f.action(submission());
    assert.deepEqual([(active.body as Record<string, any>).run.id, (active.body as Record<string, any>).run.status], [resumed, "running"]);
    assert.equal(starts(await f.calls()), 0);

    // Without a running run, the finished deterministic run is returned with its
    // terminal status: nothing restarts and no inputs are re-submitted.
    await f.change({ removeRun: resumed, runStatus: { id: result.run.id, status: "complete" } });
    const finished = await f.action(submission());
    assert.deepEqual([(finished.body as Record<string, any>).run.id, (finished.body as Record<string, any>).run.existing, (finished.body as Record<string, any>).run.status],
      [result.run.id, true, "complete"]);
    assert.equal(starts(await f.calls()), 0);
    assert.equal((await f.state()).runs.length, 1);

    // More than ten newer finished runs of the issue push the deterministic run out
    // of the reference page; it is still read directly by ID and returned as is.
    await f.change({ addRuns: Array.from({ length: 11 }, (_, index) => ({ id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`, subject: result.issue.number, status: "complete" })) });
    const older = await f.action(submission());
    assert.equal(older.status, 200, String(older.body));
    assert.deepEqual([(older.body as Record<string, any>).run.id, (older.body as Record<string, any>).run.status, (older.body as Record<string, any>).run.workflow],
      [result.run.id, "complete", "issue-to-merge-actions-ci"]);
    assert.equal(starts(await f.calls()), 0);
  } finally { await f.worker.dispose(); }
});

test("attaching records the submission and trusted attribution once, after the issue is checked", async () => {
  const f = await installed();
  try {
    const planning: AppActor = { kind: "app", id: "planning-installation" };
    const attached = await f.action(submission({ issue: 3 }), { actor: planning, originActor: codex });
    assert.equal(attached.status, 200, String(attached.body));
    assert.deepEqual((attached.body as Record<string, any>).issue, { number: 3, url: "https://github.com/acme/app/issues/3", created: false });
    const [comment] = (await f.state()).comments[3];
    assert.match(comment.body, /^## Submitted to Software Foundry: Add CSV export/);
    assert.match(comment.body, /Admins export monthly reports\./);
    assert.match(comment.body, /- \[ \] Totals match the report/);
    assert.match(comment.body, /Export reports \(`use-case:export-reports`/);
    assert.match(comment.body, /for user `owner` by app `planning-installation`, initiated by oauth-client `codex-client` \(`Codex`\)\./);
    let calls = await f.calls();
    assert.equal(calls.filter((call) => call.operation === "connector.execute" && call.input.operation === "issues.create").length, 0, "attaching never creates an issue");
    assert.equal(starts(calls), 1);

    // A retry with the same request ID posts no second comment and starts nothing.
    assert.equal((await f.action(submission({ issue: 3 }), { actor: planning, originActor: codex })).status, 200);
    assert.equal((await f.state()).comments[3].length, 1);
    assert.equal(starts(await f.calls()), 0);

    // Closed issues and pull requests are refused before any comment or start.
    for (const issue of [4, 5]) assert.equal((await f.action(submission({ issue, requestId: `cccccccc-${issue}111-4111-8111-111111111111` }))).status, 409);
    calls = await f.calls();
    assert.equal(writes(calls), 0);

    // Provenance in the input is rejected; it never overrides the verified callers.
    for (const forged of [{ requestedBy: "admin" }, { actor: { kind: "member", id: "admin" } }, { originActor: codex }])
      assert.equal((await f.action(submission({ issue: 3, ...forged }))).status, 400);
  } finally { await f.worker.dispose(); }
});

test("the webhook can start first; a later submission records the request on the issue's running run", async () => {
  const f = await installed();
  try {
    const webhookRun = "44444444-4444-4444-8444-444444444444";
    assert.equal(await f.webhook(3, webhookRun), "started");
    await f.calls();
    const attached = await f.action(submission({ issue: 3 }));
    assert.equal(attached.status, 200, String(attached.body));
    assert.deepEqual([(attached.body as Record<string, any>).run.id, (attached.body as Record<string, any>).run.existing], [webhookRun, true]);
    assert.equal((await f.state()).comments[3].length, 1);
    assert.equal(starts(await f.calls()), 0);
  } finally { await f.worker.dispose(); }
});

test("platform access, approval and role are checked before any side effect", async () => {
  const f = await installed();
  try {
    // Foundry asks for no separate issue approval: it names the subscription's
    // connection resource and the platform's refusal (revoked connection,
    // undeclared operation) stops the submission before anything is written.
    const before = await f.state();
    for (const [operations, extra] of [[["issues.create"], { issue: 3 }], [["issues.comment"], {}]] as const) {
      await f.change({ operations });
      await f.calls();
      const refused = await f.action(submission(extra));
      assert.equal(refused.status, 403);
      assert.equal((await f.calls()).filter((call) => call.operation === "workflow.start").length, 0);
      const after = await f.state();
      assert.deepEqual([after.issues, after.comments, after.runs], [before.issues, before.comments, []]);
    }
    await f.change({ operations: ["issues.create", "issues.comment"] });
    // Unavailable repositories and projects that do not include the repository are refused.
    assert.equal((await f.action(submission({ target: { repository: "acme/other" } }))).status, 409);
    const project = await f.dispatch("/api/apps/software-foundry/projects", { body: { name: "Billing", repositories: ["acme/billing"] } });
    assert.equal(project.status, 201, await project.clone().text());
    const { id } = await project.json() as { id: string };
    assert.equal((await f.action(submission({ target: { repository: "acme/app", project: id } }))).status, 409);
    // A member who is not an owner or admin cannot submit.
    await f.calls();
    assert.equal((await f.action(submission(), { role: "member" })).status, 403);
    assert.equal(writes(await f.calls()), 0);
    assert.deepEqual((await f.state()).runs, []);
  } finally { await f.worker.dispose(); }
});

const renderContext = { identity: { userId: "owner" }, actor: codex, originActor: codex } as never;
/** A description that makes the rendered body exactly `length` characters. */
type Render = (input: ReturnType<typeof submitInput.parse>) => string;
function sized(length: number, render: Render, extra: Record<string, unknown>) {
  const criteria = Array.from({ length: 11 }, (_, index) => `${index}`.padEnd(2000, "c"));
  const base = render(submitInput.parse(submission({ ...extra, description: "x", acceptanceCriteria: criteria }))).length - 1;
  return submission({ ...extra, description: "d".repeat(length - base), acceptanceCriteria: criteria });
}

test("the rendered issue or comment is bounded before any host call", async () => {
  const f = await installed();
  try {
    await f.calls();
    const renders: [Render, Record<string, unknown>][] = [[(input) => intakeIssueBody(renderContext, input), {}], [(input) => intakeComment(renderContext, input), { issue: 3 }]];
    for (const [index, [render, extra]] of renders.entries()) {
      // One character over the connector's limit, with every field inside its own bound: refused before any call.
      const over = sized(bodyLimit + 1, render, { ...extra, requestId: "dddddddd-1111-4111-8111-111111111111" });
      assert.equal(render(submitInput.parse(over)).length, bodyLimit + 1);
      const refused = await f.action(over);
      assert.equal(refused.status, 400, String(refused.body));
      assert.match(String(refused.body), /renders to 60001 characters; the intake accepts at most 60000/);
      assert.deepEqual(await f.calls(), []);
      // Exactly at the limit is written.
      const exact = sized(bodyLimit, render, { ...extra, requestId: index ? "eeeeeeee-2222-4222-8222-222222222222" : requestId });
      assert.equal(render(submitInput.parse(exact)).length, bodyLimit);
      assert.equal((await f.action(exact)).status, 200);
      await f.calls();
    }
    // Criteria that each fit their own bound can still exceed the total.
    const many = await f.action(submission({ requestId: "eeeeeeee-1111-4111-8111-111111111111", acceptanceCriteria: Array.from({ length: 50 }, () => "c".repeat(2000)) }));
    assert.equal(many.status, 400);
    assert.deepEqual(await f.calls(), []);
  } finally { await f.worker.dispose(); }
});

test("a caller's display label is shown literally in a code span beside its stable ID", async () => {
  const f = await installed();
  try {
    const hostile: AppActor = { kind: "oauth-client", id: "hostile-client", label: "Evil `x` @acme/team <!-- note -->\nnext" };
    const reply = await f.action(submission({ requestId: "ffffffff-1111-4111-8111-111111111111", description: "Ping @acme/maintainers about `code`." }), { actor: hostile, originActor: hostile });
    assert.equal(reply.status, 200, String(reply.body));
    const body = (await f.state()).issues[(reply.body as Record<string, any>).issue.number].body;
    assert.ok(body.includes("by oauth-client `hostile-client` (`Evil x @acme/team !-- note -- next`)."), body);
    // The work itself is not rewritten.
    assert.ok(body.startsWith("Ping @acme/maintainers about `code`."));
  } finally { await f.worker.dispose(); }
});

test("project routing, payload conflicts, concurrent claims and result reads", async () => {
  const f = await installed();
  try {
    const created = await f.dispatch("/api/apps/software-foundry/projects", {body:{name:"Project",repositories:["acme/app"]}});
    const project = await created.json() as {id:string};
    const input = submission({target:{project:project.id}});
    const replies = await Promise.all([f.action(input),f.action(input)]);
    assert.ok(replies.some(reply=>reply.status===200));
    assert.ok(replies.every(reply=>[200,409].includes(reply.status)));
    assert.equal(Object.keys((await f.state()).issues).length,4);
    const settled = await f.action(input);
    assert.equal(settled.status,200);
    assert.equal((await f.action({...input,title:"Changed"})).status,409);
    const response = await f.dispatch("/api/internal/actions/v1/call", {actor:codex,originActor:codex,body:{action:"work.get",input:{requestId}}});
    assert.equal(response.status,200,await response.clone().text());
    const result = await response.json() as any;
    assert.equal(result.issue.number,(settled.body as any).issue.number);
    assert.equal(result.run.id,(settled.body as any).run.id);
    assert.deepEqual(result.pullRequests,[]);
    assert.match(result.blockers[0],/No verified pinned/);
    await f.change({runOutputs:{id:result.run.id,outputs:{"implement.outputs.result":{complete:true,value:{change:{number:22,headSha:"a".repeat(40)}}}}}});
    const evidenced = await f.dispatch("/api/internal/actions/v1/call", {body:{action:"work.get",input:{submissionId:result.submissionId}}});
    assert.equal(evidenced.status,200,await evidenced.clone().text());
    const pinned = await evidenced.json() as any;
    assert.equal(pinned.pullRequests[0].headSha,"a".repeat(40));
    assert.equal(pinned.pullRequests[0].mergeSha,"b".repeat(40));
    assert.equal(pinned.pullRequests[0].reviews[0].commit_id,"a".repeat(40));
    const denied = await f.dispatch("/api/internal/actions/v1/call", {role:"member",body:{action:"work.get",input:{requestId}}});
    assert.equal(denied.status,403);
    const unknown = await f.dispatch("/api/internal/actions/v1/call", {body:{action:"work.get",input:{requestId:"12345678-1111-4111-8111-111111111111"}}});
    assert.equal(unknown.status,404);
    const ambiguous = await f.dispatch("/api/apps/software-foundry/projects", {body:{name:"Ambiguous",repositories:["acme/app","acme/other"]}});
    const multiple = await ambiguous.json() as {id:string};
    assert.equal((await f.action(submission({target:{project:multiple.id},requestId:"12345678-2222-4222-8222-222222222222"}))).status,409);
  } finally {await f.worker.dispose();}
});

test("an uncertain provider write recovers only a positively located scoped marker", async () => {
  const f = await installed();
  try {
    await f.change({failAfterCreate:true});
    const first = await f.action(submission());
    assert.equal(first.status,502);
    assert.equal(Object.keys((await f.state()).issues).length,4);
    await f.calls();
    const recovered = await f.action(submission());
    assert.equal(recovered.status,200,String(recovered.body));
    assert.equal((recovered.body as any).issue.created,false);
    assert.equal((await f.calls()).filter(call=>call.operation === "connector.execute").length,0);
    assert.equal(Object.keys((await f.state()).issues).length,4);
  } finally {await f.worker.dispose();}
});

test("attachment validation failure leaves the retry identity available", async () => {
  const f = await installed();
  try {
    const input = submission({issue:4});
    const failed = await f.action(input);
    assert.equal(failed.status,409);
    assert.match(String(failed.body),/open issue/);
    await f.change({issueState:{number:4,state:"open"}});
    assert.equal((await f.action(input)).status,200);
  } finally {await f.worker.dispose();}
});

test("frozen criteria drive execution and include canonical traceability", async () => {
  const f = await installed();
  try {
    const ref = {installationId:"wiki",type:"AcceptanceCriterion",id:"csv-criterion",revision:2};
    const workPackage = {version:1 as const,rendered:"Approved brief",digest:"0".repeat(64),sources:[ref],criteria:[{...ref,condition:"Admin requests CSV",expectedOutcome:"Downloads matching report"}]};
    workPackage.digest = await workPackageDigest(workPackage);
    const input = submission({description:"Ignored legacy description",acceptanceCriteria:["Different legacy checklist"],workPackage});
    const result = await f.action(input);
    assert.equal(result.status,200,String(result.body));
    const body = (await f.state()).issues[(result.body as any).issue.number].body;
    assert.match(body,/Admin requests CSV → Downloads matching report/);
    assert.match(body,/AcceptanceCriterion:csv-criterion.*revision `2`/);
    assert.ok(body.includes(workPackage.digest));
    assert.ok(!body.includes("Different legacy checklist"));
    assert.ok(!body.includes("Ignored legacy description"));
    assert.match(body,/outfitter-request:request:[a-f0-9]{64}/);
    const bad = await f.action({...input,requestId:"dddddddd-1111-4111-8111-111111111111",workPackage:{...workPackage,criteria:[{...workPackage.criteria[0],expectedOutcome:"Changed"}]}});
    assert.equal(bad.status,400);
  } finally {await f.worker.dispose();}
});

test("historical readback survives project deletion, superseded heads and landing-only runs", async () => {
  const f = await installed();
  try {
    const project = await (await f.dispatch("/api/apps/software-foundry/projects",{body:{name:"History",repositories:["acme/app"]}})).json() as any;
    const result = await f.action(submission({target:{project:project.id}}));
    assert.equal(result.status,200);
    const submitted = result.body as any;
    await f.change({runOutputs:{id:submitted.run.id,outputs:{"implement.outputs.result":{complete:true,value:{changes:[{number:22,headSha:"c".repeat(40)},{number:22,headSha:"a".repeat(40)}]}}}},runStatus:{id:submitted.run.id,status:"complete"},addRun:{id:"44444444-2222-4222-8222-222222222222",subject:submitted.issue.number,status:"complete"},pullMerged:false});
    assert.equal((await f.dispatch(`/api/apps/software-foundry/projects/${project.id}`,{method:"DELETE",body:{revision:1}})).status,200);
    const get = async () => f.dispatch("/api/internal/actions/v1/call",{body:{action:"work.get",input:{submissionId:submitted.submissionId}}});
    const response = await get();
    assert.equal(response.status,200,await response.clone().text());
    const read = await response.json() as any;
    assert.equal(read.run.id,"44444444-2222-4222-8222-222222222222");
    assert.equal(read.pullRequests.length,1);
    assert.equal(read.pullRequests[0].headSha,"a".repeat(40));
    assert.equal(read.pullRequests[0].mergeSha,null,"open PR test-merge commit is not a merged receipt");
    assert.deepEqual(read.blockers,[]);
    await f.change({runOutputs:{id:submitted.run.id,outputs:{"implement.outputs.result":{complete:true,value:{changes:[{number:22,headSha:"a".repeat(40)},{number:99,headSha:"a".repeat(40)}]}}}}});
    const partial = await get();
    assert.equal(partial.status,200);
    const evidence = await partial.json() as any;
    assert.equal(evidence.pullRequests.length,1);
    assert.match(evidence.blockers[0],/PR 99 evidence unavailable/);
    const hidden = await f.dispatch("/api/internal/actions/v1/call",{role:"member",body:{action:"work.get",input:{requestId:"ffffffff-1111-4111-8111-111111111111"}}});
    assert.equal(hidden.status,403,"authorization precedes nonexistent receipt lookup");
  } finally {await f.worker.dispose();}
});

test("post-provider authority denial retains the claim when no marker can be recovered", async () => {
  const f = await installed();
  try {
    await f.change({failAfterCreate:true,failAfterStatus:403});
    assert.equal((await f.action(submission())).status,403);
    const created = Object.keys((await f.state()).issues).find(number=>Number(number)>5);
    assert.ok(created);
    await f.change({clearIssueBody:Number(created)});
    await f.calls();
    const retry = await f.action(submission());
    assert.equal(retry.status,409);
    assert.match(String(retry.body),/outcome uncertain/);
    assert.equal((await f.calls()).filter(call=>call.operation === "connector.execute").length,0);
  } finally {await f.worker.dispose();}
});

test("uncertain attachment recovers its comment after the issue closes", async () => {
  const f = await installed();
  try {
    await f.change({failAfterCreate:true});
    assert.equal((await f.action(submission({issue:3}))).status,502);
    await f.change({issueState:{number:3,state:"closed"}});
    // Recovered submissions retain the completed run; a fixture operator run
    // stands for the execution that closed this issue after the uncertain write.
    await f.change({addRun:{id:"22222222-2222-4222-8222-222222222222",subject:3,status:"running"}});
    await f.calls();
    const retry = await f.action(submission({issue:3}));
    assert.equal(retry.status,200,String(retry.body));
    assert.equal((await f.state()).comments[3].length,1);
    assert.equal((await f.calls()).filter(call=>call.operation === "connector.execute").length,0);
  } finally {await f.worker.dispose();}
});

test("large optional evidence collections retain bounded records and nullable obsolete reviews", async () => {
  const f = await installed();
  try {
    const submissionResult = await f.action(submission());
    assert.equal(submissionResult.status,200);
    const submitted = submissionResult.body as any;
    await f.change({receiptCount:201,imageCount:101,nullReview:true,runOutputs:{id:submitted.run.id,outputs:{"implement.outputs.result":{complete:true,value:{number:22,headSha:"a".repeat(40)}}}}});
    const response = await f.dispatch("/api/internal/actions/v1/call",{body:{action:"work.get",input:{submissionId:submitted.submissionId}}});
    assert.equal(response.status,200,await response.clone().text());
    const result = await response.json() as any;
    assert.equal(result.evidence.receipts.length,200);
    assert.equal(result.evidence.receipts[0].deliveryId,"delivery-0");
    assert.equal(result.evidence.images.length,100);
    assert.equal(result.evidence.images[0].id,"image-0");
    assert.ok(result.evidence.gaps.some((gap:string)=>/200-record bound/.test(gap)));
    assert.ok(result.evidence.gaps.some((gap:string)=>/100-record bound/.test(gap)));
    assert.ok(!result.evidence.gaps.some((gap:string)=>/unavailable/.test(gap)));
    assert.equal(result.pullRequests.length,1);
    const reviews = result.pullRequests[0].reviews;
    assert.equal(reviews.length,2);
    assert.equal(reviews[0].commit_id,null);
    assert.equal(reviews.filter((review:any)=>review.commit_id === result.pullRequests[0].headSha).length,1,"obsolete null-commit review is preserved but cannot count as exact-head evidence");
    assert.deepEqual(result.blockers,[]);
  } finally {await f.worker.dispose();}
});

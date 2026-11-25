import assert from "node:assert/strict";
import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import { operations } from "@ai-outfitter/app-sdk/workflow-host";
import type { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readWorkflowPackage } from "@ai-outfitter/workflow-core/source";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { graphql } from "graphql";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { generatedPlanningIssue } from "../src/server/planning-issues";
import { documents } from "../src/server/documents";
import { graphqlSchema } from "../src/server/graphql";
import type { IntakeContext } from "../src/server/intake";
import { findPlan, planWork, planWorkInput, readPlanArtifact } from "../src/server/planning";

const home = "ks.systems/native-apple";
const charts = "ks.systems/charts";
const ids = new Map([[home, 14], [charts, 23]]);
const anchorLink = `https://forge.example/${home}/issues/9`;
const featureTemplate = ".forgejo/ISSUE_TEMPLATE/feature.md";

const legacyRequestId = "abbd77d6-418d-431d-8e25-66257dcea552";
const legacyRunId = "9272b0eb-2fe2-43b9-a341-c77a622476da";
const legacyFailure = "Foundry could not produce a verified plan from the selected evidence.";
const outputSlot = "plan.outputs.result";

type StoredRun = {
  run: { id: string; workflowId: string; createdBy: string; status: "running" | "complete" | "failed" };
  inputs: Record<string, unknown>;
  outputs: Record<string, { value: unknown; complete: boolean }>;
  attempts: { failure: string }[];
  inference?: NonNullable<z.output<typeof operations["workflow.read"]["output"]>>["inference"];
};

function fixture(t: TestContext, options: {
  denyRead?: string; denyWrite?: boolean; uncertain?: boolean; noTemplate?: boolean; missingIssue?: boolean;
  legacy?: boolean; bigEvidence?: boolean; inferenceGate?: Promise<void>; kind?: "bug" | "feature" | "query";
  publisher?: number; connectionId?: string; loseFirstStartReceipt?: boolean; loseCollect?: number[]; splitCollect?: number[];
  extraRepositories?: boolean; inferenceErrors?: (Response | Error | null)[]; templateText?: string;
  extraTemplates?: { path: string; text: string }[]; issueTemplate?: string; issueBody?: string;
} = {}) {
  const repositoryIds = new Map(ids);
  if (options.extraRepositories) {
    for (let index = 0; index < 6; index++) repositoryIds.set(`ks.systems/fixture-${index}`, index + 100);
  }
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL("../migrations/0008_foundry_plans.sql", import.meta.url), "utf8"));
  const migrate = () => sqlite.exec(readFileSync(new URL("../migrations/0009_foundry_plan_recovery.sql", import.meta.url), "utf8"));
  if (!options.legacy) migrate();
  const database = drizzle(async (sql, params, method) => {
    const statement = sqlite.prepare(sql);
    statement.setReturnArrays(true);
    if (method === "run") { statement.run(...params); return { rows: [] }; }
    const rows = statement.all(...params);
    return { rows: method === "get" ? rows[0] as unknown as unknown[] : rows };
  });
  const calls: { op: string; input: Record<string, any> }[] = [];
  let body = "";
  let collectCalls = 0;
  let inferenceCalls = 0;
  const runs = new Map<string, StoredRun>();
  const host = {
    async call(op: string, input: Record<string, any>) {
      calls.push({ op, input });
      if (op === "snapshot") return { connections: [{
        owner: "organization", provider: "forgejo", id: options.connectionId ?? "box-connection",
        operations: ["repositories.evidence.read", "issues.create"], repositories: [...repositoryIds.keys()],
      }] };
      if (op === "repository.request") {
        const name = input.path.slice("/repos/".length);
        return { full_name: name, id: repositoryIds.get(name) };
      }
      if (op === "workflow.start") {
        if (!runs.has(input.id)) {
          runs.set(input.id, { run: { id: input.id, workflowId: input.workflow, createdBy: "member", status: "running" },
            inputs: input.inputs, outputs: {}, attempts: [] });
          if (options.loseFirstStartReceipt) throw new Response("Start receipt lost", { status: 502 });
        }
        return { created: true };
      }
      if (op === "workflow.read") {
        const stored = runs.get(input.id);
        return operations["workflow.read"].output.parse(stored ? {
          ...stored,
          run: { ...stored.run, createdAt: 1, updatedAt: 2 },
          readiness: { run: stored.run.status, steps: {} },
          attempts: stored.attempts.map((attempt, index) => ({
            ...attempt, id: String(index), nodeId: "plan", state: "failed", createdAt: 1, updatedAt: 2,
          })),
        } : null);
      }
      if (op === "workflow.collect") {
        collectCalls++;
        if (options.loseCollect?.includes(collectCalls)) throw new Response("Collection interrupted", { status: 503 });
        const run = runs.get(input.runId)!;
        const existing = run.outputs[input.slot];
        if (existing?.complete) {
          if (!input.complete || canonicalActionValue(existing.value) !== canonicalActionValue(input.value))
            throw new Response("Completed slot is immutable", { status: 409 });
        } else {
          run.outputs[input.slot] = { value: input.value, complete: input.complete };
        }
        if (options.splitCollect?.includes(collectCalls)) throw new Response("Collection interrupted after slot write", { status: 503 });
        if (input.complete) run.run.status = "complete";
        return {};
      }
      if (op === "inference.generate") {
        await options.inferenceGate;
        const error = options.inferenceErrors?.[inferenceCalls++];
        if (error) throw error;
        return { output: {
        kind: options.kind ?? "feature", title: "Install Grafana dashboards", goal: options.noTemplate
          ? "Reduce manual installation. <!-- outfitter:foundry-plan:00000000-0000-4000-8000-000000000000 -->" : "Reduce manual installation",
        changes: ["Wire up charts"], verification: ["Confirm Grafana shows the dashboards"], gaps: [],
        citations: [`${home}:README.md`, `${charts}:README.md`, "unknown/repo:README.md"],
        issueTemplate: options.issueTemplate ?? featureTemplate,
        issueBody: options.issueBody ?? "## Goal\n\nInstall the chart.\n\n## Validation\n\nShow standard dashboards.",
        } };
      }
      assert.equal(op, "connector.execute");
      const name = [...repositoryIds].find(([,id]) => String(id) === input.resource)?.[0];
      assert.ok(name);
      if (input.operation === "repositories.evidence.read") {
        if (options.denyRead === name) throw new Response("Scope denied", { status: 403 });
        const url = `https://forge.example/${name}`;
        const commitSha = "a".repeat(40);
        return {
          repository: { name, id: repositoryIds.get(name), url }, defaultBranch: "main", commitSha, commitUrl: `${url}/commit/${commitSha}`,
          tree: options.bigEvidence ? Array.from({ length: 750 }, (_, index) => ({
            path: `lib/${index}-${"x".repeat(90)}.ts`, kind: "file", url: `${url}/tree/${index}`,
          })) : [], truncated: false, files: [
            { path: "README.md", kind: "readme", url: `${url}/src/commit/${commitSha}/README.md`, text: options.bigEvidence ? "🧪\t\n".repeat(5000) : name },
            ...(name === home && !options.noTemplate ? [
              ...(options.extraTemplates ?? []), { path: featureTemplate, text: options.templateText ?? "## Goal\n\n## Validation" },
            ].map(file => ({ ...file, kind: "issue-template", url: `${url}/src/commit/${commitSha}/${file.path}` })) : []),
          ],
        };
      }
      assert.equal(name, home);
      if (input.operation === "issues.preflight-create") {
        if (options.denyWrite) throw new Response("Anchor issue capabilities denied", { status: 403 });
        return { allowed: true, botUserId: options.publisher ?? 42 };
      }
      if (input.operation === "issues.create") {
        body = input.input.body;
        if (options.uncertain) throw new Response("Response lost after create", { status: 502 });
        return { number: 9, state: "open", url: anchorLink, created: true };
      }
      assert.equal(input.operation, "issues.find-by-marker");
      return options.missingIssue ? null : { number: 9, state: "open", url: anchorLink, created: false };
    },
  };
  const identity = { userId: "member", organizationId: "org", installationId: "installed", role: "owner", canEdit: true,
    owner: { kind: "organization", id: "org" } } as const;
  const actor = { kind: "oauth-client", id: "mcp" } as const;
  const context = { host: () => host, db: () => database, origin: "https://foundry.example", identity, actor, originActor: actor } as unknown as IntakeContext;
  const input = { requestId: crypto.randomUUID(), request: "Plan a native iOS and macOS Grafana install", repositories: [...repositoryIds.keys()], anchorRepository: home };
  async function seedLegacy({ createIssue = false, workflowStatus = "complete", appMessage = legacyFailure,
    artifact = null, issue = null }: { createIssue?: boolean; workflowStatus?: StoredRun["run"]["status"];
      appMessage?: string; artifact?: string | null; issue?: string | null } = {}) {
    assert.ok(options.legacy);
    const replay = planWorkInput.parse({ ...input, requestId: legacyRequestId, createIssue,
      anchorRepository: createIssue ? home : undefined });
    const repositories = [charts, home].sort();
    const anchor = replay.anchorRepository ?? null;
    const key = await sha256Hex(JSON.stringify(["org", "installed", "member", legacyRequestId]));
    const digest = await sha256Hex(JSON.stringify([replay.request, repositories, anchor, createIssue, null]));
    sqlite.prepare(`INSERT INTO foundry_plans
      (key, requestId, runId, digest, repositoryGrants, repositories, anchorRepository, issuePublisherId, state, updatedAt, artifact, issue, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?)`).run(key, legacyRequestId, legacyRunId, digest,
      JSON.stringify(repositories.map(name => ({ name, connectionId: "box-connection", repositoryId: ids.get(name) }))),
      JSON.stringify(repositories), anchor, createIssue ? 42 : null, Date.now(), artifact, issue, appMessage);
    migrate();
    const workflow: StoredRun = {
      run: { id: legacyRunId, workflowId: "foundry-plan-work", createdBy: "member", status: workflowStatus },
      inputs: { "plan.inputs.requestId": legacyRequestId, "plan.inputs.repositories": repositories,
        "plan.inputs.anchorRepository": anchor, "plan.inputs.createIssue": createIssue },
      outputs: {},
      attempts: [],
      inference: { status: "settled", reasons: ["aborted", "no_response"] },
    };
    if (workflowStatus === "complete") workflow.outputs[outputSlot] = { complete: true, value: {
      status: "failed", repositories, anchorRepository: anchor, run: { id: legacyRunId, workflow: "foundry-plan-work",
        url: `https://foundry.example/workflows?workflow=foundry-plan-work&run=${legacyRunId}` },
      kind: null, issue: null, message: legacyFailure, artifacts: [],
    } };
    runs.set(legacyRunId, workflow);
    return { replay, workflow };
  }
  return { context, input, calls, body: () => body, sqlite, runs, seedLegacy };
}

test("PlanWork accepts interior owner dots and rejects path aliases in scope and anchor", () => {
  const input = { requestId: crypto.randomUUID(), request: "Plan fixture", repositories: ["KS.Systems/OS"], anchorRepository: "KS.Systems/OS" };
  assert.equal(planWorkInput.safeParse(input).success, true);
  for (const name of [".ks.systems/os", "ks.systems./os", "ks..systems/os", "ks.systems/..",
    "ks.systems/.os", "ks.systems/os.", "ks.systems/os%2Fcharts", "ks.systems/os/charts"]) {
    assert.equal(planWorkInput.safeParse({ ...input, repositories: [name] }).success, false, name);
    assert.equal(planWorkInput.safeParse({ ...input, anchorRepository: name }).success, false, name);
  }
});

test("planning reads every explicit repo, writes only the anchor and reconciles an uncertain issue", async t => {
  const { context, input, calls, body } = fixture(t, { uncertain: true });
  const first = await planWork(context, planWorkInput.parse(input));
  assert.equal(first.status, "publication_uncertain");
  assert.deepEqual(first.repositories, [charts, home]);
  assert.equal(first.anchorRepository, home);
  assert.match(body(), /## Validation/);
  assert.match(body(), new RegExp(`<!-- outfitter:foundry-plan:${first.run.id} -->`));
  assert.equal(await generatedPlanningIssue(context.db, "14", { repository: { id: 14, full_name: home }, issue: { number: 9, user: { id: 42 }, body: body() } }), true);
  assert.equal(await generatedPlanningIssue(context.db, "23", { repository: { id: 23, full_name: charts }, issue: { number: 9, user: { id: 42 }, body: body() } }), false);
  assert.equal(await generatedPlanningIssue(context.db, "14", { repository: { id: 14, full_name: home }, issue: { number: 9, user: { id: 13 }, body: body() } }), false);
  const second = await planWork(context, planWorkInput.parse({ ...input, repositories: [...input.repositories].reverse() }));
  assert.equal(second.run.id, first.run.id);
  assert.equal(second.status, "published");
  assert.equal(await generatedPlanningIssue(context.db, "14", {
    repository: { id: 14, full_name: home }, issue: { number: 9, user: { id: 42 }, body: "Edited by its owner" },
  }), true);
  assert.deepEqual(second.issue, { number: 9, url: anchorLink, created: false });
  assert.equal(calls.filter(call => call.op === "workflow.start").length, 1);
  for (const operation of ["issues.create", "issues.find-by-marker"])
    assert.equal(calls.filter(call => call.input.operation === operation).length, 1);
  const read = await findPlan(context, { requestId: input.requestId });
  assert.deepEqual(read.plan.sources.map((source: { name: string }) => source.name), [charts, home]);
  assert.deepEqual(read.plan.citations.map((source: { repository: string }) => source.repository), [home, charts]);
  assert.deepEqual(JSON.parse(await readPlanArtifact(context, { requestId: input.requestId })), read.plan);
  await assert.rejects(() => planWork(context, planWorkInput.parse({ ...input, anchorRepository: charts })), (error: Response) => error.status === 409);
});

test("read/write denials and out-of-scope anchors prevent dispatch", async t => {
  for (const options of [{ denyRead: charts }, { denyWrite: true }]) {
    const { context, input, calls } = fixture(t, options);
    await assert.rejects(() => planWork(context, planWorkInput.parse(input)), (error: Response) => error.status === 403);
    assert.ok(calls.every(call => call.op !== "workflow.start" && call.input.operation !== "issues.create"));
    await assert.rejects(() => planWork(context, planWorkInput.parse({ ...input, anchorRepository: "other/project" })),
      (error: Response) => error.status === 400);
  }
});

test("artifact-only planning needs no anchor or issue grants and isolates each caller", async t => {
  const { context, input, calls } = fixture(t, { denyWrite: true });
  const artifactOnly = { ...input, createIssue: false, anchorRepository: undefined };
  const result = await planWork(context, planWorkInput.parse(artifactOnly));
  assert.equal(result.status, "artifacts_only");
  assert.equal(result.anchorRepository, null);
  assert.equal(result.issue, null);
  assert.equal(result.artifacts.length, 1);
  assert.ok(calls.every(call => !call.input.operation?.startsWith("issues.")));
  await assert.rejects(
    () => findPlan({ ...context, identity: { ...context.identity, userId: "unrelated" } }, { requestId: input.requestId }),
    (error: Response) => error.status === 404,
  );
});


test("fallback plans escape model markers before adding the durable issue marker", async t => {
  const { context, input, body } = fixture(t, { noTemplate: true });
  const result = await planWork(context, planWorkInput.parse(input));
  assert.equal(result.status, "published");
  assert.match(body(), /&lt;!-- outfitter:foundry-plan:00000000-0000-4000-8000-000000000000/);
  assert.deepEqual([...body().matchAll(/<!-- outfitter:foundry-plan:([^ ]+) -->/g)].map(match => match[1]), [result.run.id]);
  assert.equal(await generatedPlanningIssue(context.db, "14", {
    repository: { id: 14, full_name: home }, issue: { number: 9, user: { id: 42 }, body: body() },
  }), true);
});

test("same request replays a legacy prepublication failure with a settled no-response host ledger", async t => {
  const workflowStatus = "complete";
  const { context, calls, sqlite, runs, seedLegacy } = fixture(t, { legacy: true });
  const { replay, workflow } = await seedLegacy({ workflowStatus });
  const original = structuredClone(workflow);
  const recovered = await planWork(context, replay);
  assert.equal(recovered.status, "artifacts_only");
  assert.notEqual(recovered.run.id, legacyRunId);
  const readback = await findPlan(context, { requestId: legacyRequestId });
  assert.equal(readback.run.id, recovered.run.id);
  assert.deepEqual(readback.failedAttempts, recovered.failedAttempts);
  assert.deepEqual(readback.failedAttempts[0].reasons, ["aborted", "no_response"]);
  assert.equal(readback.failedAttempts[0].remoteCompute, "unknown");
  assert.equal(readback.failedAttempts[0].actorAttribution, "member_only");
  const row = sqlite.prepare("SELECT requestId, runId, failedAttempts FROM foundry_plans").get()!;
  assert.equal(row.requestId, legacyRequestId);
  assert.equal(row.runId, recovered.run.id);
  const history = JSON.parse(String(row.failedAttempts));
  assert.deepEqual(history, [{ runId: legacyRunId, message: legacyFailure, failureCode: null, failedAt: history[0].failedAt,
    workflowStatus, reasons: ["aborted", "no_response"] }]);
  assert.deepEqual(runs.get(legacyRunId), original);
  assert.equal(calls.filter(call => call.op === "workflow.start").length, 1);
  assert.equal(calls.filter(call => call.input.operation === "repositories.evidence.read").length, 2);
  assert.equal(calls.filter(call => call.input.operation === "issues.create").length, 0);
  assert.equal((await planWork(context, replay)).run.id, recovered.run.id);
  assert.equal(calls.filter(call => call.op === "inference.generate").length, 1);
  const differentActor = { ...context, actor: { ...context.actor, id: "other-client" } };
  await assert.rejects(() => planWork(differentActor, replay), (error: Response) => error.status === 403);
});

test("concurrent same-ID retries launch one new inference and archive the old run once", async t => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const { context, calls, sqlite, seedLegacy } = fixture(t, { legacy: true, inferenceGate: promise });
  const { replay } = await seedLegacy();
  const concurrent = Array.from({ length: 8 }, () => planWork(context, replay));
  try {
    const racingReceipt = await Promise.race(concurrent);
    assert.equal(racingReceipt.status, "in_progress");
    assert.notEqual(racingReceipt.run.id, legacyRunId);
    assert.equal(calls.filter(call => call.op === "workflow.start").length, 1);
  } finally {
    resolve();
  }
  const results = await Promise.all(concurrent);
  assert.equal(new Set(results.map(result => result.run.id)).size, 1);
  assert.ok(results.some(result => result.status === "artifacts_only"));
  assert.ok(results.every(result => ["in_progress", "artifacts_only"].includes(result.status)));
  assert.equal(calls.filter(call => call.op === "inference.generate").length, 1);
  assert.equal(sqlite.prepare("SELECT json_array_length(failedAttempts) AS count FROM foundry_plans").get()?.count, 1);
});

test("legacy recovery rechecks payload, write access, repository grants, evidence and publisher", async t => {
  const status = (expected: number) => (error: Response) => error.status === expected;
  for (const options of [{ denyRead: charts }, { denyWrite: true }, { connectionId: "replacement" }, { publisher: 99 }]) {
    const { context, calls, seedLegacy } = fixture(t, { ...options, legacy: true });
    const { replay } = await seedLegacy({ createIssue: true });
    await assert.rejects(() => planWork(context, replay), status(403));
    assert.ok(calls.every(call => call.op !== "workflow.start" && call.input.operation !== "issues.create"));
  }
  const { context, calls, seedLegacy } = fixture(t, { legacy: true });
  const { replay } = await seedLegacy({ createIssue: true });
  await assert.rejects(() => planWork(context, { ...replay, request: "Replace the payload" }), status(409));
  await assert.rejects(() => planWork(context, { ...replay, createIssue: false }), status(409));
  await assert.rejects(() => planWork({ ...context, identity: { ...context.identity, access: "read" } }, replay), status(403));
  await assert.rejects(() => planWork({ ...context, originActor: { kind: "member", id: "different-origin" } }, replay), status(403));
  await assert.rejects(() => findPlan({ ...context, identity: { ...context.identity, userId: "another-user" } },
    { requestId: legacyRequestId }), status(404));
  assert.ok(calls.every(call => call.op !== "workflow.start" && call.input.operation !== "issues.create"));
});

test("legacy recovery fails closed on uncertain, mismatched or completed publication evidence", async t => {
  const mutations: Record<string, (workflow: StoredRun) => void> = {
    "pending receipt": workflow => { workflow.outputs[outputSlot].complete = false; },
    "published receipt": workflow => { workflow.outputs[outputSlot].value = { status: "published", issue: { number: 9 } }; },
    "running run": workflow => { workflow.run.status = "running"; },
    "running legacy failure without a receipt": workflow => { workflow.run.status = "running"; workflow.outputs = {}; },
    "different actor": workflow => { workflow.run.createdBy = "another-user"; },
    "different inputs": workflow => { workflow.inputs["plan.inputs.createIssue"] = true; },
    "completed without a receipt": workflow => { workflow.outputs = {}; },
    "failed without a receipt": workflow => { workflow.run.status = "failed"; workflow.outputs = {}; },
    "older host with no inference proof": workflow => { delete workflow.inference; },
    "no recorded inference": workflow => { workflow.inference = { status: "none", reasons: [] }; },
    "still-active inference": workflow => { workflow.inference = { status: "pending", reasons: ["no_response"] }; },
    "settled with no affirmative no-response evidence": workflow => { workflow.inference = { status: "settled", reasons: ["aborted"] }; },
    "contradictory HTTP outcome": workflow => { workflow.inference = { status: "settled", reasons: ["no_response", "http_error"] }; },
    "interrupted attempt without a terminal outcome": workflow => { workflow.inference = { status: "settled", reasons: ["no_response", "interrupted"] }; },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    await t.test(label, async sub => {
      const { context, calls, seedLegacy } = fixture(sub, { legacy: true });
      const { replay, workflow } = await seedLegacy({ workflowStatus: "complete" });
      mutate(workflow);
      const result = await planWork(context, replay);
      assert.equal(result.run.id, legacyRunId);
      assert.equal(result.status, "failed");
      assert.ok(calls.every(call => !["workflow.start", "workflow.collect", "inference.generate"].includes(call.op)));
    });
  }
  for (const fields of [{ appMessage: "Unknown failure" }, { artifact: '{"plan":{"kind":"feature"}}' }, { issue: '{"number":9}' }]) {
    const { context, calls, seedLegacy } = fixture(t, { legacy: true });
    const { replay } = await seedLegacy(fields);
    assert.equal((await planWork(context, replay)).run.id, legacyRunId);
    assert.ok(calls.every(call => call.op !== "workflow.start"));
  }
  const { context, calls, runs, seedLegacy } = fixture(t, { legacy: true });
  const { replay } = await seedLegacy();
  runs.delete(legacyRunId);
  assert.equal((await planWork(context, replay)).run.id, legacyRunId);
  assert.ok(calls.every(call => call.op !== "workflow.start"));
});

test("uncertain publication with no match remains on the original run and only reconciles", async t => {
  const { context, input, calls } = fixture(t, { uncertain: true, missingIssue: true });
  const replay = planWorkInput.parse(input);
  const first = await planWork(context, replay);
  const second = await planWork(context, replay);
  assert.equal(second.run.id, first.run.id);
  assert.equal(second.status, "publication_uncertain");
  assert.equal(calls.filter(call => call.input.operation === "issues.create").length, 1);
  assert.equal(calls.filter(call => call.input.operation === "issues.find-by-marker").length, 1);
  assert.equal(calls.filter(call => call.op === "inference.generate").length, 1);
});

test("controlled inference beyond 60s retains its claim with bounded evidence and query classification", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { promise, resolve } = Promise.withResolvers<void>();
  const { context, input, calls } = fixture(t, { bigEvidence: true, inferenceGate: promise, kind: "query", extraRepositories: true });
  const replay = planWorkInput.parse({ ...input, request: String.fromCharCode(1).repeat(8000), kind: "query", createIssue: false });
  const workflow = readWorkflowPackage(fileURLToPath(new URL("../workflows/foundry-plan-work/", import.meta.url)));
  assert.deepEqual(workflow.definition.steps.find(step => step.id === "plan")?.inference,
    { maxOutputTokens: 1800, reasoningEffort: "low" });
  const running = graphql({ schema: graphqlSchema, source: documents.PlanWork.document,
    variableValues: { input: replay }, contextValue: context });
  try {
    while (!calls.some(call => call.op === "inference.generate")) {
      const early = await Promise.race([running, new Promise<void>(done => setImmediate(done))]);
      if (early) assert.fail(`PlanWork resolved before inference: ${JSON.stringify(early)}`);
    }
    t.mock.timers.setTime(Date.now() + 90_000);
    const redelivery = { ...context };
    assert.equal((await planWork(redelivery, replay)).status, "in_progress");
    t.mock.timers.setTime(Date.now() + 600_000);
    assert.equal((await planWork(redelivery, replay)).status, "in_progress");
  } finally {
    resolve();
  }
  const response = await running;
  assert.equal(response.errors, undefined);
  const result = response.data?.planWork as Awaited<ReturnType<typeof planWork>>;
  assert.equal(result.status, "artifacts_only");
  assert.equal(result.kind, "query");
  const inference = calls.filter(call => call.op === "inference.generate");
  assert.equal(inference.length, 1);
  assert.equal(inference[0].input.data.request, replay.request);
  assert.equal(inference[0].input.data.kind, "query");
  assert.equal(inference[0].input.data.evidence.length, 8);
  assert.ok(Buffer.byteLength(JSON.stringify(inference[0].input.data)) <= 63_000);
  const artifact = JSON.parse(await readPlanArtifact(context, { requestId: replay.requestId }));
  assert.ok(artifact.sources.every((source: { truncated: boolean }) => source.truncated));
  for (const item of inference[0].input.data.evidence) {
    assert.ok(Buffer.byteLength(JSON.stringify(item)) <= 2500);
    assert.equal(item.truncated, true);
    assert.match(item.commitSha, /^[a-f0-9]{40}$/);
  }
  assert.equal(calls.filter(call => call.input.operation === "issues.create").length, 0);
});

test("a lost start response reuses the claimed run and keeps bug classification", async t => {
  const { context, calls, sqlite, seedLegacy } = fixture(t, { legacy: true, loseFirstStartReceipt: true, kind: "bug" });
  const { replay } = await seedLegacy();
  await assert.rejects(() => planWork(context, replay), (error: Response) => error.status === 502);
  assert.ok(calls.every(call => call.op !== "inference.generate"));
  const result = await planWork(context, replay);
  assert.equal(result.status, "artifacts_only");
  assert.equal(result.kind, "bug");
  assert.deepEqual(calls.filter(call => call.op === "workflow.start").map(call => call.input.id), [result.run.id, result.run.id]);
  assert.equal(calls.filter(call => call.op === "inference.generate").length, 1);
  assert.equal(sqlite.prepare("SELECT json_array_length(failedAttempts) AS count FROM foundry_plans").get()?.count, 1);
});

test("a planning claim left behind by a lost worker never becomes eligible on elapsed time", async t => {
  const { context, calls, sqlite, seedLegacy } = fixture(t, { legacy: true });
  const { replay } = await seedLegacy();
  sqlite.prepare("UPDATE foundry_plans SET state = 'planning', message = NULL, updatedAt = ?").run(Date.now() - 900_000);
  const result = await planWork(context, replay);
  assert.equal(result.status, "in_progress");
  assert.equal(result.run.id, legacyRunId);
  assert.ok(calls.every(call => !["workflow.start", "inference.generate", "workflow.collect"].includes(call.op)));
});

const inferenceTimeout = () => new Response(
  "Inference timed out before the proposal was complete. Retry with fewer selected sources.", { status: 504 },
);

test("typed inference failure is visible, a lost collection is repaired, and the replacement limit holds", async t => {
  const { context, calls, input, runs } = fixture(t, { loseCollect: [1, 3], inferenceErrors: [inferenceTimeout(), inferenceTimeout()] });
  const replay = planWorkInput.parse({ ...input, createIssue: false });
  await assert.rejects(() => planWork(context, replay), (error: Response) => error.status === 503);
  const failed = await findPlan(context, replay);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureCode, "timeout");
  assert.deepEqual(failed.failedAttempts, []);
  assert.equal(runs.get(failed.run.id)?.run.status, "running");

  // Replay repairs the first loss and starts the replacement, whose own
  // collection fails independently.
  await assert.rejects(() => planWork(context, replay), (error: Response) => error.status === 503);
  const second = await findPlan(context, replay);
  assert.notEqual(second.run.id, failed.run.id);
  assert.equal(second.failureCode, "timeout");
  assert.equal(runs.get(second.run.id)?.run.status, "running");
  assert.equal(runs.get(failed.run.id)?.run.status, "complete");
  assert.equal(second.failedAttempts[0].runId, failed.run.id);
  assert.equal(second.failedAttempts[0].failureCode, "timeout");
  assert.equal(second.failedAttempts[0].actorAttribution, "actor_bound");
  assert.deepEqual(second.failedAttempts[0].reasons, []);
  const secondRun = runs.get(second.run.id)!;
  secondRun.inference = { status: "pending", reasons: [] };
  assert.equal((await planWork(context, replay)).run.id, second.run.id);
  assert.equal(secondRun.run.status, "running");
  secondRun.inference = { status: "settled", reasons: ["no_response", "aborted"] };
  assert.equal((await planWork(context, replay)).run.id, second.run.id);
  assert.equal(secondRun.run.status, "complete");
  assert.equal(runs.get(second.run.id)?.outputs[outputSlot].complete, true);
  assert.equal((runs.get(second.run.id)?.outputs[outputSlot].value as { failureCode: string }).failureCode, "timeout");
  assert.equal((await planWork(context, replay)).run.id, second.run.id);
  assert.deepEqual((await findPlan(context, replay)).failedAttempts, second.failedAttempts);
  assert.deepEqual(calls.filter(call => call.op === "workflow.collect").map(call => call.input.runId), [
    failed.run.id, failed.run.id, second.run.id, second.run.id,
  ]);
  assert.equal(calls.filter(call => call.op === "inference.generate").length, 2);
  assert.equal(calls.filter(call => call.op === "workflow.start").length, 2);
});

test("inference gateway ambiguity is inspectable without response text and never authorizes another run", async t => {
  const detail = "PRIVATE PROVIDER ERROR";
  const { context, input, calls, sqlite, runs } = fixture(t, { inferenceErrors: [new Response(detail, { status: 504 })] });
  const replay = planWorkInput.parse({ ...input, createIssue: false });
  const first = await planWork(context, replay);
  assert.equal(first.failureCode, "transport");
  assert.equal(first.status, "failed");
  assert.ok(!JSON.stringify(await findPlan(context, replay)).includes(detail));
  assert.ok(!JSON.stringify(sqlite.prepare("SELECT * FROM foundry_plans").get()).includes(detail));
  assert.equal(runs.get(first.run.id)?.run.status, "running");
  assert.equal((await planWork(context, replay)).run.id, first.run.id);
  assert.equal(calls.filter(call => call.op === "workflow.collect").length, 0);
  assert.equal(calls.filter(call => call.op === "inference.generate").length, 1);
});

test("classifies unstructured, token-limited and invalid model answers", async t => {
  const cases = [
    ["no_structured_answer", new Response("Inference answer unavailable", { status: 502 })],
    ["output_limit", new Response("Inference output reached its token limit before the proposal was complete. Retry with fewer selected sources.", { status: 502 })],
    ["invalid_output", null],
  ] as const;
  for (const [code, error] of cases) {
    const { context, input, calls } = fixture(t, { inferenceErrors: [error] });
    const replay = planWorkInput.parse({ ...input, kind: "bug", createIssue: false });
    const result = await planWork(context, replay);
    assert.equal(result.failureCode, code);
    assert.equal(result.status, "failed");
    assert.equal(result.artifacts.length, 0);
    assert.equal(calls.filter(call => call.input.operation === "issues.create").length, 0);
  }
});

test("projected anchor templates carry all the headings publication validates", async t => {
  const templateText = `## Goal\n\n${"x".repeat(1000)}\n\n## Validation`;
  const { context, input, calls } = fixture(t, { templateText });
  assert.equal((await planWork(context, planWorkInput.parse(input))).status, "published");
  const inference = calls.find(call => call.op === "inference.generate");
  const template = inference?.input.data.evidence.find((repo: { repository: string }) => repo.repository === home)
    .files.find((file: { path: string }) => file.path === featureTemplate);
  assert.deepEqual(template.requiredHeadings, ["Goal", "Validation"]);
});

test("a rejected draft repairs only collection on same-ID replay", async t => {
  const settings = { issueBody: "## Goal\n\nMissing validation.", loseCollect: [1], publisher: 42 };
  const { context, input, calls, runs } = fixture(t, settings);
  const replay = planWorkInput.parse(input);
  await assert.rejects(() => planWork(context, replay), (error: Response) => error.status === 503);
  const failed = await findPlan(context, replay);
  const originalArtifact = await readPlanArtifact(context, replay);
  const workflow = runs.get(failed.run.id)!;
  const denied = (error: Response) => error.status === 403;

  assert.equal(failed.status, "failed");
  assert.equal(failed.artifacts.length, 1);
  assert.equal(failed.plan.issue, null);
  assert.equal(workflow.run.status, "running");
  await assert.rejects(() => planWork({ ...context, actor: { ...context.actor, id: "other-oauth" } }, replay), denied);
  await assert.rejects(() => planWork(context, { ...replay, request: "Different scope" }), (error: Response) => error.status === 409);
  settings.publisher = 43;
  await assert.rejects(() => planWork(context, replay), denied);
  settings.publisher = 42;
  assert.equal(calls.filter(call => call.op === "workflow.collect").length, 1);

  workflow.run.createdBy = "other-member";
  assert.equal((await planWork(context, replay)).run.id, failed.run.id);
  assert.equal(workflow.run.status, "running");
  workflow.run.createdBy = "member";

  const repaired = await planWork(context, replay);
  assert.equal(repaired.run.id, failed.run.id);
  assert.equal(workflow.run.status, "complete");
  assert.deepEqual(workflow.outputs[outputSlot].value, calls.find(call => call.op === "workflow.collect")!.input.value);
  assert.equal(await readPlanArtifact(context, replay), originalArtifact);
  assert.deepEqual(await planWork(context, replay), repaired);
  assert.equal(calls.filter(call => call.op === "workflow.collect").length, 2);
  assert.equal(calls.filter(call => call.op === "workflow.start").length, 1);
  assert.equal(calls.filter(call => call.op === "inference.generate").length, 1);
  assert.equal(calls.filter(call => call.input.operation === "issues.create").length, 0);
});

test("known kind reserves an accepted template past unrelated file and byte limits", async t => {
  const extraTemplates = Array.from({ length: 6 }, (_, index) => ({
    path: `.forgejo/ISSUE_TEMPLATE/defect-${index}.md`, text: `## ${"long".repeat(250)}`,
  }));
  const { context, input, calls } = fixture(t, { extraTemplates });
  assert.equal((await planWork(context, planWorkInput.parse({ ...input, kind: "feature" }))).status, "published");
  const anchor = calls.find(call => call.op === "inference.generate")!.input.data.evidence.find((item: { repository: string }) => item.repository === home);
  assert.ok(anchor.files.some((file: { path: string }) => file.path === featureTemplate));
  assert.ok(anchor.files.length <= 5);
  assert.ok(Buffer.byteLength(JSON.stringify(anchor)) <= 2500);
});

test("inferred kind reserves both accepted templates before filling bytes", async t => {
  const bug = ".github/ISSUE_TEMPLATE/report.md";
  const { context, input, calls } = fixture(t, {
    kind: "bug", issueTemplate: bug,
    extraTemplates: [
      ...Array.from({ length: 4 }, (_, index) => ({
        path: `.forgejo/ISSUE_TEMPLATE/enhancement-${index}.md`, text: `## ${"escaped\\".repeat(300)}`,
      })),
      { path: bug, text: "name: Defect report\n## Goal\n## Validation" },
    ],
  });
  assert.equal((await planWork(context, planWorkInput.parse(input))).status, "published");
  const anchor = calls.find(call => call.op === "inference.generate")!.input.data.evidence.find((item: { repository: string }) => item.repository === home);
  assert.ok(anchor.files.some((file: { path: string }) => file.path === featureTemplate));
  assert.ok(anchor.files.some((file: { path: string }) => file.path === bug));
  assert.ok(anchor.files.length <= 5);
  assert.ok(Buffer.byteLength(JSON.stringify(anchor)) <= 2500);
});

test("the legacy SQL claim blocks a stale draft or send while the replacement runs", async t => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const { context, sqlite, calls, seedLegacy } = fixture(t, { legacy: true, inferenceGate: promise, kind: "query" });
  const { replay } = await seedLegacy({ createIssue: true });
  const stale = sqlite.prepare("SELECT key, updatedAt FROM foundry_plans WHERE runId = ?").get(legacyRunId)!;
  const processing = planWork(context, replay);
  try {
    while (!calls.some(call => call.op === "inference.generate")) {
      const early = await Promise.race([processing, new Promise<void>(done => setImmediate(done))]);
      if (early) assert.fail("Replacement returned before inference");
    }
    const active = sqlite.prepare("SELECT runId, state, updatedAt, artifact FROM foundry_plans").get()!;
    assert.notEqual(active.runId, legacyRunId);
    assert.equal(active.state, "planning");
    assert.ok(Number(active.updatedAt) > Number(stale.updatedAt));
    // The pre-update worker only compared key, state and updatedAt. Both
    // successful CAS results were mandatory before it could send an issue.
    const legacyUpdate = sqlite.prepare("UPDATE foundry_plans SET state = ?, artifact = ?, updatedAt = ? WHERE key = ? AND state = ? AND updatedAt = ? RETURNING runId");
    const staleDraft = legacyUpdate.get("ready", "stale draft", Date.now(), stale.key, "planning", stale.updatedAt);
    const staleSend = legacyUpdate.get("sending", "stale draft", Date.now(), stale.key, "ready", stale.updatedAt);
    assert.equal(staleDraft, undefined);
    assert.equal(staleSend, undefined);
    assert.deepEqual(sqlite.prepare("SELECT runId, state, updatedAt, artifact FROM foundry_plans").get(), active);
  } finally {
    resolve();
  }
  const recovered = await processing;
  assert.equal(recovered.status, "artifacts_only");
  assert.equal(recovered.failedAttempts[0].remoteCompute, "unknown");
  assert.ok(calls.every(call => call.input.operation !== "issues.create"));
});

test("a required template that cannot fit the evidence budget still blocks publication", async t => {
  const { context, input, calls } = fixture(t, { templateText: `## ${"heading".repeat(400)}` });
  const result = await planWork(context, planWorkInput.parse({ ...input, kind: "feature" }));
  assert.equal(result.status, "failed");
  assert.equal(result.artifacts.length, 1);
  const anchor = calls.find(call => call.op === "inference.generate")!.input.data.evidence.find((item: { repository: string }) => item.repository === home);
  assert.equal(anchor.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(anchor)) <= 2500);
  assert.ok(calls.every(call => call.input.operation !== "issues.create"));
});

for (const draft of [false, true]) {
  test(`a split collection reconciles only the exact immutable ${draft ? "rejected draft" : "typed failure"} receipt`, async t => {
    const { context, input, calls, runs, sqlite } = fixture(t, {
      splitCollect: [1],
      ...(draft ? { issueBody: "## Goal\n\nMissing validation." } : { inferenceErrors: [inferenceTimeout()] }),
    });
    const replay = planWorkInput.parse({ ...input, createIssue: draft });
    await assert.rejects(() => planWork(context, replay), (error: Response) => error.status === 503);
    const failed = await findPlan(context, replay);
    const run = runs.get(failed.run.id)!;
    const saved = run.outputs[outputSlot];
    const artifact = draft ? await readPlanArtifact(context, replay) : null;
    assert.equal(run.run.status, "running");
    assert.equal(saved.complete, true);

    if (draft) {
      // Rejected drafts from before actor digests can be repaired by the
      // original member acting directly.
      sqlite.prepare("UPDATE foundry_plans SET actorDigest = NULL WHERE runId = ?").run(failed.run.id);
      await assert.rejects(() => planWork({ ...context, originActor: { ...context.originActor, id: "other" } }, replay),
        (error: Response) => error.status === 403);
    }

    const divergent = { ...saved, value: { ...(saved.value as object), message: "Different receipt" } };
    run.outputs[outputSlot] = divergent;
    assert.equal((await planWork(context, replay)).run.id, failed.run.id);
    assert.equal(run.run.status, "running");
    assert.equal(run.outputs[outputSlot], divergent);
    run.outputs[outputSlot] = { ...saved, complete: false };
    assert.equal((await planWork(context, replay)).run.id, failed.run.id);
    run.outputs[outputSlot] = saved;
    run.outputs["other.outputs.result"] = saved;
    assert.equal((await planWork(context, replay)).run.id, failed.run.id);
    delete run.outputs["other.outputs.result"];
    assert.equal(calls.filter(call => call.op === "workflow.collect").length, 1);
    assert.equal(calls.filter(call => call.op === "inference.generate").length, 1);

    // Preserve the immutable value even if a host JSON round trip changes key order.
    const reordered = { ...saved, value: Object.fromEntries(Object.entries(saved.value as object).reverse()) };
    run.outputs[outputSlot] = reordered;
    const repaired = await planWork(context, replay);
    assert.equal(run.run.status, "complete");
    assert.equal(run.outputs[outputSlot], reordered);
    const originalCollections = calls.filter(call => call.op === "workflow.collect" && call.input.runId === failed.run.id);
    assert.equal(originalCollections.length, 2);
    assert.deepEqual(Object.keys(originalCollections[1].input.value), Object.keys(reordered.value));
    assert.equal(repaired.status, draft ? "failed" : "artifacts_only");
    assert.equal(repaired.run.id === failed.run.id, draft);
    assert.deepEqual(await planWork(context, replay), repaired);
    assert.equal(calls.filter(call => call.op === "workflow.collect" && call.input.runId === failed.run.id).length, 2);
    assert.equal(calls.filter(call => call.op === "inference.generate").length, draft ? 1 : 2);
    assert.ok(calls.every(call => call.input.operation !== "issues.create"));
    if (draft) assert.equal(await readPlanArtifact(context, replay), artifact);
  });
}

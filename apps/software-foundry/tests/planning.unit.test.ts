import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { IntakeContext } from "../src/server/intake";
import { findPlan, generatedPlanningIssue, planWork, planWorkInput, readPlanArtifact } from "../src/server/planning";

const home = "box/native-apple";
const charts = "box/charts";
const ids = new Map([[home, 14], [charts, 23]]);
const anchorLink = "https://forge.example/box/native-apple/issues/9";
const featureTemplate = ".forgejo/ISSUE_TEMPLATE/feature.md";

function fixture(t: TestContext, options: { denyRead?: string; denyWrite?: boolean; uncertain?: boolean } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL("../migrations/0008_foundry_plans.sql", import.meta.url), "utf8"));
  const database = drizzle(async (sql, params, method) => {
    const statement = sqlite.prepare(sql);
    statement.setReturnArrays(true);
    if (method === "run") { statement.run(...params); return { rows: [] }; }
    const rows = statement.all(...params);
    return { rows: method === "get" ? rows[0] as unknown as unknown[] : rows };
  });
  const calls: { op: string; input: Record<string, any> }[] = [];
  let body = "";
  let isComplete = false;
  const host = {
    async call(op: string, input: Record<string, any>) {
      calls.push({ op, input });
      if (op === "snapshot") return { connections: [{
        owner: "organization", provider: "forgejo", id: "box-connection",
        operations: ["repositories.evidence.read", "issues.create"], repositories: [home, charts],
      }] };
      if (op === "repository.request") {
        const name = input.path.slice("/repos/".length);
        return { full_name: name, id: ids.get(name) };
      }
      if (op === "workflow.start") return { created: true };
      if (op === "workflow.read") return { run: { status: isComplete ? "complete" : "running" } };
      if (op === "workflow.collect") { isComplete = input.complete; return {}; }
      if (op === "inference.generate") return { output: {
        kind: "feature", title: "Install Grafana dashboards", goal: "Reduce manual installation",
        changes: ["Wire up charts"], verification: ["Confirm Grafana shows the dashboards"], gaps: [],
        citations: [`${home}:README.md`, `${charts}:README.md`, "unknown/repo:README.md"],
        issueTemplate: featureTemplate, issueBody: "## Goal\n\nInstall the chart.\n\n## Validation\n\nShow standard dashboards.",
      } };
      assert.equal(op, "connector.execute");
      const name = [...ids].find(([,id]) => String(id) === input.resource)?.[0];
      assert.ok(name);
      if (input.operation === "repositories.evidence.read") {
        if (options.denyRead === name) throw new Response("Scope denied", { status: 403 });
        const url = `https://forge.example/${name}`;
        const commitSha = "a".repeat(40);
        return {
          repository: { name, id: ids.get(name), url }, defaultBranch: "main", commitSha, commitUrl: `${url}/commit/${commitSha}`,
          tree: [], truncated: false, files: [
            { path: "README.md", kind: "readme", url: `${url}/src/commit/${commitSha}/README.md`, text: name },
            ...(name === home ? [{ path: featureTemplate, kind: "issue-template", url: `${url}/src/commit/${commitSha}/${featureTemplate}`, text: "## Goal\n\n## Validation" }] : []),
          ],
        };
      }
      assert.equal(name, home);
      if (input.operation === "issues.preflight-create") {
        if (options.denyWrite) throw new Response("Anchor issue capabilities denied", { status: 403 });
        return { allowed: true, botUserId: 42 };
      }
      if (input.operation === "issues.create") {
        body = input.input.body;
        if (options.uncertain) throw new Response("Response lost after create", { status: 502 });
        return { number: 9, state: "open", url: anchorLink, created: true };
      }
      assert.equal(input.operation, "issues.find-by-marker");
      return { number: 9, state: "open", url: anchorLink, created: false };
    },
  };
  const identity = { userId: "member", organizationId: "org", installationId: "installed", role: "owner", canEdit: true,
    owner: { kind: "organization", id: "org" } } as const;
  const actor = { kind: "oauth-client", id: "mcp" } as const;
  const context = { host: () => host, db: () => database, origin: "https://foundry.example", identity, actor, originActor: actor } as unknown as IntakeContext;
  const input = { requestId: crypto.randomUUID(), request: "Plan a native iOS and macOS Grafana install", repositories: [charts, home], anchorRepository: home };
  return { context, input, calls, body: () => body };
}

test("planning reads every explicit repo, writes only the anchor and reconciles an uncertain issue", async t => {
  const { context, input, calls, body } = fixture(t, { uncertain: true });
  const first = await planWork(context, planWorkInput.parse(input));
  assert.equal(first.status, "publication_uncertain");
  assert.deepEqual(first.repositories, [charts, home]);
  assert.equal(first.anchorRepository, home);
  assert.match(body(), /## Validation/);
  assert.match(body(), new RegExp(`<!-- outfitter:foundry-plan:${first.run.id} -->`));
  assert.equal(await generatedPlanningIssue(context, "14", { repository: { id: 14, full_name: home }, issue: { number: 9, user: { id: 42 }, body: body() } }), true);
  assert.equal(await generatedPlanningIssue(context, "23", { repository: { id: 23, full_name: charts }, issue: { number: 9, user: { id: 42 }, body: body() } }), false);
  assert.equal(await generatedPlanningIssue(context, "14", { repository: { id: 14, full_name: home }, issue: { number: 9, user: { id: 13 }, body: body() } }), false);
  const second = await planWork(context, planWorkInput.parse({ ...input, repositories: [...input.repositories].reverse() }));
  assert.equal(second.run.id, first.run.id);
  assert.equal(second.status, "published");
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

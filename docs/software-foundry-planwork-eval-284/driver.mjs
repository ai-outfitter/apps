import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { admin, openPlatform, seedRepositories } from "./box-fixture.mjs";
import { exerciseInterrupted } from "./interrupted.mjs";
import { cases, exerciseLegacy } from "./legacy.mjs";
import { callTool, mcpClient, oauthToken, signIn } from "./mcp.mjs";

export const app = "software-foundry";
export const title = "Synthetic Aster Charts PlanWork";
export const platformModel = true;

const scenario = JSON.parse(readFileSync(new URL("./fixtures/scenario.json", import.meta.url)));
const arm = process.env.PLANWORK_ARM;
const publication = arm === "uncertainty";
const input = { ...scenario, createIssue: publication,
  ...(publication ? { anchorRepository: "box/native-apple" } : {}) };

export async function run(box) {
  const report = { arm, requestId: input.requestId, attempts: [], checks: {} };
  const out = name => join(box.out, name);
  const save = () => writeFileSync(out("report.json"), JSON.stringify(report, null, 2) + "\n");
  const db = openPlatform(box);
  const root = `http://outfitter.localhost:${box.port}`;
  let failure;
  try {
    await seedRepositories(box, db);
    const installation = db.prepare(
      "SELECT id, template, activeHash, activeScript FROM app_installations WHERE template = 'software-foundry' AND organizationId IS NOT NULL",
    ).get();
    assert.ok(installation?.activeHash && installation.activeScript, "The box has an active installed Worker");
    report.installation = installation;
    writeFileSync(out("provider-context.json"), JSON.stringify({
      database: box.databases.platform, installationId: installation.id,
      requestId: arm === "legacy" ? cases.settled[0] : input.requestId,
    }));
    if (arm === "uncertainty") {
      const botId = db.prepare("SELECT externalId FROM connections WHERE id = 'box-forgejo'").get().externalId;
      writeFileSync(out("mock-bot-id.txt"), botId);
    }
    const before = Object.fromEntries(await Promise.all(input.repositories.map(async repo => {
      const branches = await admin(box, "GET", `/repos/${repo}/branches`);
      assert.deepEqual(branches.map(branch => branch.name), ["main"]);
      return [repo, branches[0].commit.id];
    })));
    const cookie = await signIn(root);
    const grant = await oauthToken(root, cookie, "apps actions entities organizations offline_access");
    const resource = new URL(grant.resource);
    assert.ok([`${root}/mcp`, `http://localhost:${box.port}/mcp`].includes(resource.href));
    const mcp = mcpClient(grant);
    for (const document of ["PlanWork", "FoundryPlan"]) {
      const result = await callTool(mcp, "graph_documents", { scope: "box", search: document, schema: true });
      if (result.refused || !JSON.stringify(result.value ?? {}).includes(document)) {
        report.discoveryFailure = { document, refused: result.refused, result: result.text.slice(0, 500) };
        throw new Error(`Authenticated MCP discovery did not advertise ${document}`);
      }
    }
    async function invoke(name, document, variables, signal) {
      const result = await callTool(mcp, name, { scope: "box", app, document, variables,
        ...(name === "graph_query" ? { includeIdentifiers: true } : {}) }, signal);
      if (result.refused) {
        const error = new Error(`MCP ${document} refused the synthetic request`);
        error.toolText = result.text;
        throw error;
      }
      return result.value?.data?.[document === "PlanWork" ? "planWork" : "foundryPlan"];
    }
    async function submit(signal) {
      const entry = { startedAt: new Date().toISOString() };
      report.attempts.push(entry);
      save();
      const start = performance.now();
      try {
        entry.receipt = await invoke("graph_mutate", "PlanWork", { input }, signal);
        assert.ok(entry.receipt);
        return entry.receipt;
      } catch (error) {
        entry.error = error.message;
        throw error;
      } finally {
        entry.mcpDurationMs = Math.round(performance.now() - start);
        save();
      }
    }
    async function waitForProvider(event) {
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        if (existsSync(out("provider.jsonl"))) {
          const lines = readFileSync(out("provider.jsonl"), "utf8").trim().split("\n");
          if (lines.some(line => JSON.parse(line).event === event)) return;
        }
        await sleep(200);
      }
      throw new Error(`Provider bridge did not record ${event}`);
    }
    if (arm === "interrupted") {
      await exerciseInterrupted({ box, platform: db, installation, input, invoke, report });
    } else if (arm === "cancel") {
      const controller = new AbortController();
      const pending = submit(controller.signal).then(() => null, error => error);
      await waitForProvider("request");
      controller.abort();
      assert.equal((await pending)?.name, "AbortError");
      await waitForProvider("client-closed");
      report.checks.clientCancellationReachedProvider = true;
    } else if (arm === "short") {
      const failed = await submit();
      assert.equal(failed.status, "failed");
      assert.equal(failed.failureCode, "timeout");
      assert.equal(failed.artifacts.length, 0);
      await waitForProvider("client-closed");
      report.checks.shortStepDeadline = true;
    } else {
      let result;
      let requestId = input.requestId;
      if (arm === "legacy") {
        ({ result, requestId } = await exerciseLegacy({ box, platform: db, installation, input, invoke, waitForProvider, report }));
      } else {
        result = await submit();
      }
      if (arm === "uncertainty") {
        assert.equal(result.status, "publication_uncertain");
        const original = result;
        result = await submit();
        assert.equal(result.status, "published");
        assert.equal(result.run.id, original.run.id);
        assert.equal(result.issue.created, false);
        const mock = JSON.parse(readFileSync(out("mock-publications.json")));
        assert.equal(mock.length, 1);
        assert.equal(mock[0].lostResponse, true);
        report.checks.uncertainPublicationReconciledReadOnly = true;
      } else {
        assert.equal(result.status, "artifacts_only");
        assert.equal(result.issue, null);
        assert.ok(!existsSync(out("mock-publications.json")));
      }
      const queried = await invoke("graph_query", "FoundryPlan", { input: { requestId } });
      assert.equal(queried.run.id, result.run.id);
      assert.deepEqual(queried.artifacts, result.artifacts);
      assert.equal(result.artifacts.length, 1);
      const artifact = result.artifacts[0];
      const url = new URL(artifact.url);
      assert.equal(url.hostname, "software-foundry.box.outfitter.localhost");
      assert.equal(url.pathname, `/api/apps/software-foundry/plans/${requestId}`);
      url.protocol = "http:";
      url.port = String(box.port);
      const denied = await fetch(url, { redirect: "manual" });
      assert.ok(!denied.ok);
      await denied.body?.cancel();
      const download = await fetch(url, { headers: { cookie }, redirect: "manual" });
      assert.equal(download.status, 200);
      const bytes = Buffer.from(await download.arrayBuffer());
      assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
      const plan = JSON.parse(bytes);
      assert.deepEqual(plan, queried.plan);
      writeFileSync(out("plan.json"), bytes);
      report.checks.artifactReadback = { sha256: artifact.sha256, bytes: bytes.length };
      assert.equal(plan.plan.kind, input.kind);
      assert.deepEqual(plan.sources.map(source => [source.name, source.commitSha]), Object.entries(before));
      for (const repo of input.repositories) {
        assert.ok(plan.citations.some(citation => citation.repository === repo
          && citation.path === "README.md" && new URL(citation.url).pathname.includes(before[repo])));
      }
      assert.equal(plan.run.id, result.run.id);
      report.planWork = { runId: result.run.id, artifactSha256: artifact.sha256 };
      report.checks.artifact = { runId: plan.run.id, sha256: artifact.sha256, bytes: bytes.length, sourceCommits: before };
    }
  } catch (error) {
    failure = error;
    report.error = { type: error.name, message: error.message.slice(0, 900) };
  } finally {
    try {
      for (const repo of input.repositories) {
        assert.deepEqual(await admin(box, "GET", `/repos/${repo}/issues?state=all&type=issues`), []);
        assert.deepEqual(await admin(box, "GET", `/repos/${repo}/issues?state=all&type=pulls`), []);
      }
      assert.ok(!existsSync(out("blocked-write.json")));
      report.checks.noForgejoPublication = true;
      report.runs = db.prepare(
        "SELECT id, workflowId, status, definition FROM workflow_runs WHERE workflowId = 'foundry-plan-work' ORDER BY rowid",
      ).all().map(({ definition, ...run }) => ({ ...run,
        stepInference: JSON.parse(definition).steps.find(step => step.id === "plan")?.inference }));
      report.usage = db.prepare(
        "SELECT workloadKind, workloadId, requestKey, attempt, providerKind, model, attemptStatus, httpStatus, inputTokens, outputTokens, reasoningTokens, totalTokens FROM inference_usage_records WHERE workloadId IN (SELECT id FROM workflow_runs WHERE workflowId = 'foundry-plan-work') ORDER BY rowid",
      ).all();
    } catch (error) {
      failure ??= error;
      report.diagnosticsError = error.message.slice(0, 900);
    } finally {
      save();
      db.close();
    }
  }
  await box.finish(failure);
}

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { blankRepository, blankTemplates, blankYamlPath, gitCommand, githubFixture, paths, unrelatedPath, wrongBugPath } from "./github-fixture.mjs";
import { configureFoundryDispatch, installFoundryJob, runFoundryAudit } from "./foundry-job.mjs";

// Run from the webapp checkout so tsx and the existing route/DB fixtures resolve
// there.
const webapp = process.cwd();
const appsCheckout = process.env.FOUNDRY_EVAL_APPS_CHECKOUT;
const job = "community-template-audit";
const reportSlot = "check.outputs.report";
const load = (path) => import(pathToFileURL(join(webapp, path)).href);
const git = (...args) => gitCommand(args).trim();
const started = performance.now();
const routePath = "/api/plugins/github/governance";
const mainRef = "refs/heads/main";
const sort = (values) => [...values].sort();
const hashes = (root, paths) => Object.fromEntries(paths.map((path) => [
  path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex"),
]));
const report = {
  runner: process.version,
  git: git("--version"),
  appsHead: git("-C", appsCheckout ?? fileURLToPath(new URL(".", import.meta.url)), "rev-parse", "HEAD"),
  webappHead: git("rev-parse", "HEAD"),
  webappWorkingTreeClean: git("--no-optional-locks", "status", "--porcelain") === "",
  transport: "in-process GitHub REST/GraphQL fixture with bare Git repositories and local PR records",
  appEntryPoint: routePath,
  audits: {},
  cases: {},
};
if (appsCheckout) {
  configureFoundryDispatch();
  report.job = { id: job, slot: reportSlot, completedRuns: 0 };
  report.appsWorkingTreeClean = git("-C", appsCheckout, "--no-optional-locks", "status", "--porcelain") === "";
  if (!report.appsWorkingTreeClean) {
    report.appsSourceSha256 = hashes(appsCheckout, [
      "apps/software-foundry/app.json",
      "apps/software-foundry/src/pages/api/apps/software-foundry/jobs.ts",
      "apps/software-foundry/src/server/repositories.ts",
      "apps/software-foundry/src/server/workspace/workspaces.ts",
      "apps/software-foundry/workflows/community-template-audit/workflow.yaml",
      "packages/app-sdk/src/workflow-host.ts",
    ]);
  }
}
if (!report.webappWorkingTreeClean) {
  report.webappSourceSha256 = hashes(webapp, [
    "packages/app-sdk/src/workflow-host.ts",
    "src/lib/github-community-templates.ts",
    "src/lib/github-governance.ts",
    "src/lib/github-repository-access.ts",
    "src/lib/sdlc-setup.ts",
    "src/lib/sdlc-setup-github.ts",
    "src/lib/workflow-app-host.ts",
    "src/pages/api/plugins/github/governance.ts",
  ]);
}
report.fixtureSha256 = hashes(fileURLToPath(new URL(".", import.meta.url)), [
  "run.mjs", "github-fixture.mjs", "foundry-job.mjs", "foundry-dispatch.mjs",
]);
const token = `ghu_${randomUUID()}`;
const fixture = githubFixture(token);
const { routeEnvironment, routeServices, signUp, call } = await load("tests/helpers/routes.ts");
const cleanup = routeEnvironment("governance-eval");
const originalFetch = globalThis.fetch;

try {
  globalThis.fetch = fixture.fetch;
  const { db, auth } = await routeServices();
  const { member, organization, workflowRuns } = await load("src/db/schema.ts");
  const { seedGithubAuthorization } = await load("tests/helpers/github-authorization.ts");
  const route = await load("src/pages/api/plugins/github/governance.ts");
  const { id, cookie } = await signUp();
  const createdAt = new Date();
  await db.insert(organization).values({ id: "fixture-org", name: "Governance Fixture", slug: "fixture-team", createdAt });
  await db.insert(member).values({ id: "fixture-member", organizationId: "fixture-org", userId: id, role: "owner", createdAt });
  await seedGithubAuthorization(db, id, token, (await auth.$context).secretConfig);

  const origin = "http://fixture-team.localhost:4390";
  const requestFor = (method, repository, body, session = cookie) => new Request(
    `${origin}${routePath}?${new URLSearchParams({ repository })}`,
    {
      method,
      headers: { "content-type": "application/json", cookie: session, origin },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const invoke = (method, repository, body, session) => call(route[method], requestFor(method, repository, body, session));
  async function audit(repository) {
    const response = await invoke("GET", repository);
    assert.equal(response.status, 200, await response.clone().text());
    const output = await response.json();
    assert.equal(output.repository, repository);
    assert.equal(output.defaultBranch, "main");
    assert.equal(output.revision, fixture.repo(repository).existing(mainRef));
    return output;
  }
  const anonymous = await invoke("GET", "missing/repo", undefined, "");
  assert.equal(anonymous.status, 401);
  assert.equal(fixture.requests.length, 0);
  const target = appsCheckout && await installFoundryJob({ load, db, job });
  {
    const coverage = ({ communityTemplates }) => Object.fromEntries(
      Object.entries(communityTemplates.checks).map(([key, { status }]) => [key, status]),
    );
    async function approve(repository, report, session = cookie) {
      return invoke("POST", repository, {
        repository,
        action: "propose-community-templates",
        revision: report.revision,
        planId: report.communityTemplates.plan.id,
      }, session);
    }
    async function auditOnly(repository, expectedChecks, expectedPaths, expectedReplacements = []) {
      const gitRepo = fixture.repo(repository);
      const refs = gitRepo.git(["show-ref"]);
      const writes = fixture.mutations().length;
      const runs = (await db.select().from(workflowRuns)).length;
      const audited = await audit(repository);
      assert.deepEqual(coverage(audited), expectedChecks);
      assert.deepEqual(sort(audited.communityTemplates.plan.paths), sort(expectedPaths));
      assert.deepEqual(audited.communityTemplates.plan.replacements, expectedReplacements);
      assert.equal(fixture.mutations().length, writes);
      assert.equal(gitRepo.git(["show-ref"]), refs);
      assert.equal((await db.select().from(workflowRuns)).length, runs);
      assert.equal(audited.communityTemplates.canPropose, expectedPaths.length > 0);
      const { checks, plan, issueOverride } = audited.communityTemplates;
      report.audits[repository] = {
        revision: audited.revision, checks, planPaths: plan.paths, replacements: plan.replacements,
        blocked: plan.blocked, issueOverride, writeCount: 0,
      };
      if (target) {
        const { result, receipt, route } = await runFoundryAudit({
          load, db, target, job, repository, slot: reportSlot, request: requestFor("GET", repository),
        });
        const { canPropose, ...checkedTemplates } = audited.communityTemplates;
        assert.deepEqual(result.communityTemplates, checkedTemplates);
        assert.equal(result.repository, repository);
        assert.equal(result.defaultBranch, audited.defaultBranch);
        assert.equal(result.revision, audited.revision);
        assert.equal(gitRepo.git(["show-ref"]), refs);
        assert.equal(fixture.mutations().length, writes);
        assert.equal((await db.select().from(workflowRuns)).length, runs + 1);
        assert.ok(Number.isFinite(Date.parse(result.checkedAt)), "Expected a persisted audit timestamp");
        report.job.route = route;
        report.job.completedRuns++;
        report.audits[repository].workflowRun = receipt.run;
        report.audits[repository].checkedAt = result.checkedAt;
        if (repository === "team/repo") report.persistedAuditExample = result;
        return result;
      }
      return audited;
    }
    async function propose(repository, audited, expectedPaths, expectedReplacements = []) {
      const gitRepo = fixture.repo(repository);
      const first = await approve(repository, audited);
      assert.ok(first.ok, await first.clone().text());
      const firstReport = await first.json();
      assert.equal(gitRepo.pulls.length, 1);
      const [pr] = gitRepo.pulls;
      assert.equal(firstReport.status, "opened");
      assert.deepEqual(firstReport.pullRequest, { number: pr.number, url: pr.html_url, headSha: pr.head.sha });
      assert.equal(pr.state, "open");
      assert.equal(pr.draft, true);
      assert.equal(pr.base.sha, audited.revision);
      assert.equal(gitRepo.existing(mainRef), audited.revision);
      assert.equal(gitRepo.existing(`${pr.head.sha}^`), audited.revision);
      const files = expectedPaths.map((filename) => ({
        filename, status: expectedReplacements.includes(filename) ? "modified" : "added",
      }));
      const comparison = await fixture.fetch(
        `https://api.github.com/repos/${repository}/compare/${pr.base.sha}...${pr.head.sha}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      assert.equal(comparison.status, 200);
      const { files: changedFiles } = await comparison.json();
      const statuses = (files) => sort(files.map(({ filename, status }) => `${status} ${filename}`));
      assert.deepEqual(statuses(changedFiles), statuses(files));
      const writes = fixture.mutations().length;
      const replay = await approve(repository, audited);
      assert.equal(replay.status, first.status, await replay.clone().text());
      const replayReport = await replay.json();
      assert.equal(replayReport.status, "existing");
      assert.deepEqual(replayReport.pullRequest, firstReport.pullRequest);
      assert.equal(fixture.mutations().length, writes);
      assert.equal(gitRepo.pulls.length, 1);
      assert.equal(gitRepo.existing(`refs/heads/${pr.head.ref}`), pr.head.sha);
      assert.equal(gitRepo.existing(mainRef), audited.revision);
      return { base: pr.base.sha, head: pr.head.sha, files, pullRequest: pr.number, replay: "same PR; zero writes" };
    }
    const missing = "missing/repo";
    const missingReport = await auditOnly(missing, { pullRequest: "missing", bug: "missing", feature: "missing" }, Object.values(paths));
    const noSession = await approve(missing, missingReport, "");
    assert.equal(noSession.status, 401);
    const noPlan = await invoke("POST", missing, { repository: missing, action: "propose-community-templates" });
    assert.equal(noPlan.status, 400);
    const wrongPlan = await invoke("POST", missing, {
      repository: missing,
      action: "propose-community-templates",
      revision: missingReport.revision,
      planId: "0".repeat(64),
    });
    assert.equal(wrongPlan.status, 409);
    const movingRepo = fixture.repo(missing);
    const moved = movingRepo.commit(mainRef, missingReport.revision, { "README.md": "Fixture default branch moved.\n" }, "Move default branch");
    const staleRevision = await approve(missing, missingReport);
    assert.equal(staleRevision.status, 409);
    assert.equal(movingRepo.existing(mainRef), moved);
    assert.equal(movingRepo.pulls.length, 0);
    assert.equal(fixture.mutations().length, 0);
    movingRepo.git(["update-ref", mainRef, missingReport.revision, moved]);
    report.cases.explicitApproval = {
      unauthenticated: 401, absent: 400, wrongPlan: 409, staleRevision: 409, writeCount: 0,
    };
    report.cases.missing = await propose(missing, missingReport, Object.values(paths));

    const custom = "custom/repo";
    const customReport = await auditOnly(custom, { pullRequest: "missing", bug: "covered", feature: "covered" }, [paths.pr]);
    report.cases.custom = await propose(custom, customReport, [paths.pr]);

    const inherited = "team/inherited";
    const inheritedReport = await auditOnly(inherited, { pullRequest: "covered", bug: "covered", feature: "covered" }, []);
    for (const { sources } of Object.values(inheritedReport.communityTemplates.checks)) {
      assert.equal(sources[0].origin, "inherited");
      assert.equal(sources[0].repository, "team/.github");
      assert.equal(sources[0].revision, fixture.repo("team/.github").existing(mainRef));
    }
    const beforeNoOp = fixture.mutations().length;
    const noOp = await approve(inherited, inheritedReport);
    assert.ok(noOp.ok, await noOp.clone().text());
    assert.equal((await noOp.json()).status, "nothing-to-do");
    assert.equal(fixture.mutations().length, beforeNoOp);
    assert.equal(fixture.repo(inherited).pulls.length, 0);
    report.cases.inherited = { revision: inheritedReport.revision, ownerRevision: fixture.repo("team/.github").existing(mainRef), writeCount: 0 };

    const partial = "team/repo";
    const partialReport = await auditOnly(partial, { pullRequest: "covered", bug: "covered", feature: "missing" }, [paths.feature]);
    assert.equal(partialReport.communityTemplates.checks.pullRequest.sources[0].origin, "inherited");
    assert.equal(partialReport.communityTemplates.checks.bug.sources[0].origin, "local");
    assert.equal(partialReport.communityTemplates.issueOverride[0].path, paths.bug);
    const outcome = await propose(partial, partialReport, [paths.feature]);
    const gitRepo = fixture.repo(partial);
    assert.equal(gitRepo.file(outcome.head, paths.bug), gitRepo.file(outcome.base, paths.bug));
    assert.equal(gitRepo.file(outcome.head, paths.pr), null);
    report.cases.partial = outcome;

    const limited = "limited/repo";
    const limitedReport = await auditOnly(limited, { pullRequest: "covered", bug: "covered", feature: "missing" }, []);
    assert.ok(limitedReport.communityTemplates.plan.blocked.length);
    const writes = fixture.mutations().length;
    const refused = await approve(limited, limitedReport);
    assert.ok(refused.ok, await refused.clone().text());
    assert.equal((await refused.json()).status, "nothing-to-do");
    assert.equal(fixture.mutations().length, writes);
    assert.equal(fixture.repo(limited).pulls.length, 0);
    report.cases.chooserProtected = { revision: limitedReport.revision, writeCount: 0 };
    const replacementPaths = [paths.pr, paths.bug];
    const blankReport = await auditOnly(
      blankRepository, { pullRequest: "incorrect", bug: "incorrect", feature: "covered" },
      replacementPaths, replacementPaths,
    );
    const wrongBug = blankReport.communityTemplates.candidates.find(({ path }) => path === wrongBugPath);
    assert.equal(wrongBug?.status, "incorrect");
    assert.equal(wrongBug.origin, "local");
    assert.equal(wrongBug.revision, blankReport.revision);
    const blankOutcome = await propose(blankRepository, blankReport, replacementPaths, replacementPaths);
    const blankRepo = fixture.repo(blankRepository);
    for (const [path, content] of Object.entries(blankTemplates)) {
      assert.equal(blankRepo.file(blankOutcome.base, path), content);
    }
    const pullRequestTemplate = blankRepo.file(blankOutcome.head, paths.pr);
    assert.match(pullRequestTemplate, /^## Goal$/m);
    assert.match(pullRequestTemplate, /^## Changes$/m);
    assert.match(pullRequestTemplate, /^## Demo$/m);
    const bugTemplate = blankRepo.file(blankOutcome.head, paths.bug);
    assert.match(bugTemplate, /^name: Bug report$/m);
    assert.match(bugTemplate, /^## Steps to reproduce$/m);
    const preservedPaths = [paths.feature, wrongBugPath, blankYamlPath, unrelatedPath];
    for (const path of preservedPaths) {
      const original = blankRepo.existing(`${blankOutcome.base}:${path}`);
      assert.ok(original, `Expected seeded file ${path}`);
      assert.equal(blankRepo.existing(`${blankOutcome.head}:${path}`), original);
    }
    report.cases.blank = { ...blankOutcome, preservedPaths };

    const proposedRepositories = [missing, custom, partial, blankRepository];
    const writesByType = fixture.mutations().map(({ operation, name, path }) => name ?? [operation, path].join(" "));
    assert.deepEqual(writesByType, proposedRepositories.flatMap((repository) => [
      "createRef", "createCommitOnBranch", `POST /repos/${repository}/pulls`,
    ]));
    assert.equal((await db.select().from(workflowRuns)).length, report.job?.completedRuns ?? 0);
    const mirroredDrafts = await fixture.verifyForgejoDrafts();
    if (mirroredDrafts) {
      assert.deepEqual(mirroredDrafts.map(({ fixtureRepository }) => fixtureRepository), proposedRepositories);
      report.forgejoDrafts = mirroredDrafts.map(({ fixtureRepository, head, base, files, draft, state, number }) => {
        const original = fixture.repo(fixtureRepository).pulls[0];
        assert.deepEqual({ head, base, draft, state }, {
          head: original.head, base: original.base, draft: true, state: "open",
        });
        const { planPaths, replacements } = report.audits[fixtureRepository];
        assert.deepEqual(sort(files.map(({ filename, status }) => `${status} ${filename}`)),
          sort(planPaths.map((path) => `${replacements.includes(path) ? "modified" : "added"} ${path}`)));
        return { fixtureRepository, head, base, files, draft, state, number };
      });
    }
  }
  report.providerRequests = fixture.requests.length;
  report.providerMutations = fixture.mutations().length;
  report.wallMs = Math.round(performance.now() - started);
  console.log(JSON.stringify(report, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  fixture.close();
  cleanup();
}

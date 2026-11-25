import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  blankRepository, blankTemplates, blankYamlPath, gitCommand, githubFixture, paths,
  templateBranch, unrelatedPath, unselectedRepository, wrongBugPath, wrongIdRepository,
} from "./github-fixture.mjs";
import { configureFoundryDispatch, installFoundryJob, runFoundryAudit, submitFoundryAudit } from "./foundry-job.mjs";

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
const appId = "4242";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GITHUB_APP_ID = appId;
process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
const fixture = githubFixture(token, { appId, publicKey });
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
  const requestTrace = (requests) => requests.map(({ credential, operation, path }) => `${credential} ${operation} ${path}`);
  const admission = (repository) => [
    `actor GET /repos/${repository}`, `app GET /repos/${repository}/installation`,
  ];
  const mint = (repository) => `app POST ${fixture.mintPath(repository)}`;
  async function rejectAudit(repository, expectedRequests) {
    const requests = fixture.requests.length;
    const writes = fixture.mutations().length;
    const runs = await db.select({ id: workflowRuns.id }).from(workflowRuns);
    const { response } = await submitFoundryAudit({
      load, target, job, repository, request: requestFor("GET", repository),
    });
    assert.equal(response.status, 403, await response.clone().text());
    const providerTrace = requestTrace(fixture.requests.slice(requests));
    assert.deepEqual(providerTrace, expectedRequests);
    assert.equal(fixture.mutations().length, writes);
    assert.deepEqual(await db.select({ id: workflowRuns.id }).from(workflowRuns), runs);
    // The same actor can still view this same-owner repository via interactive Governance.
    const authorized = await audit(repository);
    assert.equal(fixture.mutations().length, writes);
    assert.deepEqual(await db.select({ id: workflowRuns.id }).from(workflowRuns), runs);
    return { repository, jobStatus: response.status, providerTrace, writeCount: 0, workflowRunsCreated: 0, interactiveRevision: authorized.revision };
  }
  if (target) {
    report.cases.unselectedRepository = await rejectAudit(unselectedRepository, admission(unselectedRepository));
    report.cases.wrongRepositoryId = await rejectAudit(wrongIdRepository, [
      ...admission(wrongIdRepository), mint(wrongIdRepository),
    ]);
  }
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
        const beforeJob = fixture.requests.length;
        const { result, receipt, route } = await runFoundryAudit({
          load, db, target, job, repository, slot: reportSlot, request: requestFor("GET", repository),
        });
        const jobRequests = fixture.requests.slice(beforeJob);
        assert.deepEqual(requestTrace(jobRequests.slice(0, 3)), [...admission(repository), mint(repository)]);
        const auditRequests = jobRequests.slice(3);
        assert.ok(auditRequests.some(({ credential, path }) =>
          credential === "installation" && path.startsWith(`/repos/${repository}/git/blobs/`)) ||
          auditRequests.some(({ credential, path }) =>
            credential === "installation" && path.startsWith(`/repos/${repository}/git/trees/`)));
        assert.ok(auditRequests.every(({ credential, operation, path }) =>
          (credential === "installation" && (operation === "GET" || operation === "query")) ||
          (credential === "public" && operation === "GET" && /^\/repos\/[^/]+\/\.github(?:\/|$)/.test(path))));
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
        report.audits[repository].installationReads = auditRequests.filter(({ credential }) => credential === "installation").length;
        if (repository === "team/repo") report.persistedAuditExample = result;
        return result;
      }
      return audited;
    }
    async function propose(repository, audited, expectedPaths, expectedReplacements = []) {
      const gitRepo = fixture.repo(repository);
      const priorPullCount = gitRepo.pulls.length;
      const first = await approve(repository, audited);
      assert.ok(first.ok, await first.clone().text());
      const firstReport = await first.json();
      assert.equal(gitRepo.pulls.length, priorPullCount + 1);
      const openPulls = gitRepo.pulls.filter(({ state }) => state === "open");
      assert.equal(openPulls.length, 1);
      const [pr] = openPulls;
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
      assert.equal(gitRepo.pulls.length, priorPullCount + 1);
      assert.equal(gitRepo.existing(`refs/heads/${pr.head.ref}`), pr.head.sha);
      assert.equal(gitRepo.existing(mainRef), audited.revision);
      return { base: pr.base.sha, head: pr.head.sha, files, pullRequest: pr.number, replay: "same PR; zero writes" };
    }
    async function rejectEditedDraft(repository, audited) {
      const gitRepo = fixture.repo(repository);
      const pr = gitRepo.pulls.find(({ state }) => state === "open");
      assert.ok(pr);
      const originalHead = pr.head.sha;
      const ref = `refs/heads/${pr.head.ref}`;
      const approvedFiles = Object.fromEntries(audited.communityTemplates.plan.paths.map((path) => [
        path, gitRepo.file(originalHead, path),
      ]));
      const cases = {
        changedTemplateBytes: { ...approvedFiles, [paths.pr]: "Contributor template edited after approval.\n" },
        changedFileList: { ...approvedFiles, [unrelatedPath]: "Unapproved file in the draft.\n" },
      };
      const result = {};
      const pullCount = gitRepo.pulls.length;
      for (const [scenario, files] of Object.entries(cases)) {
        // A replacement commit over the same base keeps the one-commit ancestry check passing.
        gitRepo.git(["update-ref", ref, audited.revision, originalHead]);
        const editedHead = gitRepo.commit(ref, audited.revision, files, "Edit open fixture draft");
        pr.head.sha = editedHead;
        try {
          const before = fixture.requests.length;
          const writes = fixture.mutations().length;
          const refused = await approve(repository, audited);
          assert.equal(refused.status, 409, await refused.clone().text());
          assert.ok(fixture.requests.slice(before).some(({ operation, path }) =>
            operation === "GET" && path === `/repos/${repository}/compare/${audited.revision}...${editedHead}`));
          assert.equal(fixture.mutations().length, writes);
          assert.equal(gitRepo.pulls.length, pullCount);
          assert.equal(gitRepo.existing(ref), editedHead);
          assert.equal(gitRepo.existing(mainRef), audited.revision);
          result[scenario] = { status: refused.status, head: editedHead, writeCount: 0 };
        } finally {
          gitRepo.git(["update-ref", ref, originalHead, editedHead]);
          pr.head.sha = originalHead;
        }
      }
      return result;
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
    const proposalRef = `refs/heads/${templateBranch}`;
    movingRepo.git(["update-ref", proposalRef, missingReport.revision, "0".repeat(40)]);
    const historicalHead = movingRepo.commit(proposalRef, missingReport.revision, {
      [paths.pr]: "Historical synthetic contributor template.\n",
    }, "Seed closed historical proposal");
    const closedPull = {
      number: 1,
      node_id: `fixture-pr:${missing}:1`,
      html_url: `https://github.com/${missing}/pull/1`,
      state: "closed",
      draft: true,
      head: { ref: templateBranch, sha: historicalHead },
      base: { ref: "main", sha: missingReport.revision },
    };
    movingRepo.pulls.push(closedPull);
    movingRepo.git(["update-ref", "-d", proposalRef, historicalHead]);
    assert.equal(movingRepo.existing(proposalRef), null);
    const beforeRestart = fixture.requests.length;
    report.cases.missing = await propose(missing, missingReport, Object.values(paths));
    assert.equal(report.cases.missing.pullRequest, 2);
    assert.equal(movingRepo.pulls[0], closedPull);
    assert.equal(closedPull.state, "closed");
    assert.ok(fixture.requests.slice(beforeRestart).some(({ operation, path, search }) => {
      const query = new URLSearchParams(search);
      return operation === "GET" && path === `/repos/${missing}/pulls` &&
        query.get("state") === "open" && query.get("head") === `missing:${templateBranch}`;
    }), "Expected an open-only lookup of the approved proposal branch");
    report.cases.closedProposalRestart = {
      closedPullRequest: closedPull.number, deletedBranch: templateBranch,
      freshPullRequest: report.cases.missing.pullRequest,
    };
    report.cases.editedOpenDraft = await rejectEditedDraft(missing, missingReport);

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
        const original = fixture.repo(fixtureRepository).pulls.find(({ state }) => state === "open");
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
  report.installationTokenMints = fixture.requests.filter(({ credential, operation }) =>
    credential === "app" && operation === "POST").length;
  assert.equal(report.installationTokenMints, target ? report.job.completedRuns + 1 : 0);
  report.providerMutations = fixture.mutations().length;
  report.wallMs = Math.round(performance.now() - started);
  console.log(JSON.stringify(report, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  fixture.close();
  cleanup();
}

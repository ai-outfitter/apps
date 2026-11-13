// Software Foundry's role-based workspace node policy, run by the workflow host:
// `prepare` chooses each node's workspace task, `finalize` verifies what the
// node produced against GitHub and publishes the coordinator's effects.
import {
  type finalizeInput,
  type prepareInput,
  type prepareResult,
  type WorkflowHost,
} from "@ai-outfitter/app-sdk/workflow-host";
import type { StorageLocals } from "@ai-outfitter/app-sdk/storage";
import {
  type ChangeReceipt,
  type FoundryForge,
  foundryForge,
  hostAPI,
  type ReviewReceipt,
} from "./forge";
import { actionsChecks, actionsPreview, githubActionsAppId } from "./actions-ci";
import { verifyFoundryDemo } from "./demo-handoff";
import { gatewayPreviewRequest } from "./preview-health";
import { z } from "zod";
import { startJobFix } from "./workspaces";

type Prepare = WorkflowHost<"prepare">;
type Finalize = WorkflowHost<"finalize">;
type Json = Record<string, unknown>;
/** This installation's storage and the origin its public file URLs use. */
export type Storage = { locals: StorageLocals; origin: string };

const id = z.string().min(1).max(128);
/** The Foundry policy an approved binding carries in its target `settings`. */
export const workspaceTarget = z
  .object({
    role: z.enum([
      // Not "analyze": the workspace runtime keeps gh off PATH for that legacy stage.
      "file-issues",
      "triage",
      "implement",
      "validate",
      "review",
      "repair",
      "land",
    ]),
    checks: z
      .array(
        z
          .object({
            name: id,
            commands: z.array(z.array(z.string().min(1)).min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
    ci: z.enum(["workspace", "actions"]).default("workspace"),
    reviewer: id,
    mergeQueue: z.boolean().default(false),
  })
  .strict();

function reviewerPreview(target: { role: string }, previous?: Record<string, any>) {
  // Only a preview verified for the current candidate is granted.
  return target.role === "review" && previous?.previews?.verifiedUrl &&
    previous.previews.headSha === previous.candidate?.headSha
    ? { url: previous.previews.verifiedUrl, headSha: previous.candidate.headSha } : undefined;
}
function requiresDemo(target: { role: string; ci: string }) {
  return target.ci === "actions" && ["implement", "repair", "validate", "review", "land"].includes(target.role);
}

function approvedCandidate(previous?: Record<string, any>) {
  return previous?.passed === true && previous.review?.verdict === "approved" &&
    Boolean(previous.candidate?.headSha) && previous.review.headSha === previous.candidate.headSha;
}

export function coordinatedRole(target: { ci: string; role: string }, previous?: Record<string, any>) {
  return target.ci === "actions" && (["validate", "land"].includes(target.role) ||
    (target.role === "review" && previous?.passed === false) ||
    (["repair", "review"].includes(target.role) && approvedCandidate(previous)));
}

async function actionsValidation(host: Finalize, api: Parameters<typeof actionsChecks>[0], repository: string, forge: FoundryForge,
  target: z.infer<typeof workspaceTarget>, previous: Record<string, any>, verified: ChangeReceipt) {
  if (target.role === "review") {
    if (!approvedCandidate(previous)) return { result: { ...previous, review: null } };
    // Reuse a published approval, never an agent verdict. Re-read GitHub so a
    // dismissed/superseded approval cannot silently skip independent review.
    await forge.approval(verified, previous.review);
    return { result: { ...previous, candidate: verified,
      summary: "Review skipped: existing independent approval still covers the unchanged commit.",
      reviewReuse: { status: "reused", reviewId: previous.review.id, headSha: verified.headSha } } };
  }
  const checks = await actionsChecks(api, repository, verified, target.checks.map(check => check.name));
  const passed = checks.every(check => check.passed);
  const previews = passed && repository.toLowerCase() === "ai-outfitter/webapp"
    ? await actionsPreview(api, repository, verified, gatewayPreviewRequest(input => host.call("workspace.control", input))) : undefined;
  if (passed) await forge.ready(verified);
  return { result: { ...previous, candidate: verified, checks, passed,
    validationFailures: checks.filter(check => !check.passed), ...(previews ? { previews: { ...previews, verifier: "workspace-gateway" } } : {}) } };
}


const reviewScreenshots = "For screenshot review, previous.evidence width/height are trusted original PNG IHDR dimensions, re-read from installation storage and hash-verified by the coordinator. Browser image-page screenshots and tool-rendered image sizes are not the source image dimensions. Inspect the published images visually and use their receipt dimensions; independently fetch and inspect PNG headers/hash if you dispute those receipts. A stale previous.demo gap must be checked against the current PR and published receipts, not repeated as an unresolved finding after its link is corrected.";
const publishScreenshots = [
  "The PR body must include a native Closes #ISSUE_NUMBER reference to the assigned issue before screenshot publication. If publishing returns HTTP 409, confirm that closing issue reference with gh pr view PR_NUMBER --json closingIssuesReferences, and confirm the pushed PR head equals git rev-parse HEAD. Correct PR metadata or push the intended commit before retrying; do not treat an unlinked PR as completed implementation.",
  "Screenshots are needed only when the change alters a page or component people see. Keep them outside Git (for example under test-results), never commit them or use Git LFS. After pushing the code commit and opening the PR, upload each PNG from inside its checkout with node /opt/workspace/publish-image.mjs PR_NUMBER SCREENSHOT.png and put the returned URLs in the PR Demo section. Capture distinct desktop and mobile viewports (Chrome resize_page or emulate before each), name them desktop.png and mobile.png, and embed them as ![Desktop](URL) and ![Mobile](URL). When the issue asks for before (main) and after (this branch) screenshots, capture the before shots in your checkout before editing and the after shots there after the fix (never a second checkout or a second npm ci; the workspace runs out of room), publish each pair (for example settings-before-desktop.png and settings-after-desktop.png) and show them side by side in the Demo.",
];
/** How an implementer spends its tool calls: the plan first, the code path before the test. */
const implementing = [
  "The triage plan in previous.summary names the files and checks: start there instead of re-exploring the repository. Read a file once and edit it in place; do not re-print files after each edit.",
  "Write new tests by copying the closest existing test in the same file and changing only what the plan needs. Iterate on that one test file. If a test fails twice the same way, read the code path it exercises before changing the test again.",
];
/** Repository jobs read a repository and file issues; they never change code. */
const analyzing = [
  "This is a repository job: read and run the repository in your workspace, but never commit, push, open pull requests or change repository settings. File each issue yourself with gh issue create in this repository, then report exactly the issues you created (number, url, title) in the issues output; the coordinator re-reads each one from GitHub.",
];
const reviewing = [
  "Review and validation nodes must not push code or publish reviews; the coordinator publishes their verified results.",
];

/** Each role's guidance, with repository-specific commands only for their repository. */
export function workspaceGuidance(repository: string, role = "implement") {
  const webapp = repository.toLowerCase() === "ai-outfitter/webapp";
  if (role === "review") return [
    ...reviewing, reviewScreenshots,
    ...(webapp ? ["For this webapp, build with npm run build:node before invoking tests/anonymous-onboarding.integration.mjs directly. Reviewers have read-only Actions access; inspect current-commit CI logs independently. For protected previews import installPreview from /opt/workspace/preview.mjs and call it with the Playwright context and previous.previews.verifiedUrl before page.goto; it uses the trusted gateway and assertReadOnly checks. Do not add service credentials to the browser; never try a person's login. Block only same-origin /cdn-cgi/rum telemetry during read-only fixture checks, and fail on every other product write. Report missing preview access explicitly rather than treating an Access login page as successful acceptance."] : []),
  ];
  if (role === "triage") return [];
  if (role === "file-issues") return analyzing;
  return [
    ...implementing, ...publishScreenshots,
    ...(webapp ? ["For this webapp, build with npm run build:node before invoking tests/anonymous-onboarding.integration.mjs directly."] : []),
  ];
}


/** Choose a node attempt's workspace task: a coordinator role finalizes without
 * a session; a review first confirms the reviewer and the pinned preview. */
export async function prepareWorkspaceNode(
  host: Prepare,
  { inputs, settings }: z.infer<typeof prepareInput>,
): Promise<z.input<typeof prepareResult>> {
  const target = workspaceTarget.parse(settings);
  const prior = inputs.previous as Record<string, any> | undefined;
  if (coordinatedRole(target, prior)) return { mode: "coordinator" };
  if (target.role === "review")
    await host.call("workspace.control", {
      operation: "inspect-reviewer",
      reviewer: target.reviewer,
      ...(prior?.candidate ? { candidate: { number: prior.candidate.number, headSha: prior.candidate.headSha } } : {}),
    });
  const preview = reviewerPreview(target, prior);
  if (preview) await host.call("workspace.control", { operation: "inspect-preview-access", ...preview });
  return {
    mode: "agent",
    role: target.role,
    checks: target.checks,
    guidance: workspaceGuidance((await host.call("repository.read", {})).name, target.role),
    ...(preview ? { preview: { url: preview.url, revision: preview.headSha } } : {}),
  };
}

/** The node's outputs, under its finalization claim. A coordinator produced
 * nothing itself; a workspace session is cited by its retained archive. */
export async function finalizeWorkspaceNode(
  host: Finalize,
  files: Storage,
  { node, inputs, outputs, coordinator, session, settings }: z.infer<typeof finalizeInput>,
) {
  const target = workspaceTarget.parse(settings);
  if (target.role === "file-issues") return { outputs: await finalizeAnalysis(host, inputs, outputs) };
  if (coordinator)
    return { outputs: await finalizeWorkspaceOutputs(host, files, node, inputs, target, { result: {
      ready: true, summary: "Coordinated GitHub Actions workflow step",
      ...(target.role === "repair" ? { candidate: (inputs.previous as Record<string, any> | undefined)?.candidate } : {}),
    } }) };
  const finalized = await finalizeWorkspaceOutputs(host, files, node, inputs, target, outputs);
  const result = finalized.result as Record<string, unknown>;
  result.sessionArtifact = session.artifact;
  if (session.outputRecovery) result.outputRecovery = session.outputRecovery;
  return { outputs: finalized };
}

const jobFix = z.object({ installation: z.string().min(1), resource: z.string().min(1), inputs: z.record(z.string(), z.string()) });

/** A repository job's issues, each re-read from the bound repository, so only
 * issues that exist there are reported, and each started on issue-to-merge. */
async function finalizeAnalysis(host: Finalize, inputs: Json, outputs: Json): Promise<Json> {
  const produced = z.object({
    issues: z.array(z.object({ number: z.number().int().positive() }).passthrough()).max(10),
    summary: z.string().max(32000).optional(),
  }).passthrough().parse(outputs.issues);
  const fix = jobFix.optional().parse(inputs.fix);
  const repo = await host.call("repository.read", {});
  const forge = foundryForge(hostAPI((request) => host.call("repository.request", request)), repo);
  const issues = [];
  for (const { number } of produced.issues) {
    const issue = await forge.issue(number);
    // Each issue goes straight to issue-to-merge, which opens the PR and merges it once checks pass.
    const started = fix ? await startJobFix(host, fix, { id: repo.repositoryId, name: repo.name }, issue) : undefined;
    issues.push({ number: issue.number, url: issue.url, title: issue.title, ...(started ? { fixRun: started.id } : {}) });
  }
  return { issues: { repository: repo.name, issues, ...(produced.summary ? { summary: produced.summary } : {}) } };
}

/** Publication scopes are separate from the read-only validation/review checkout. */
export function workspaceAgentPermissions(role: string): Record<string, "read"> {
  return role === "review" ? { checks: "read", actions: "read" } : {};
}

export function workspaceCoordinatorPermissions(target: Pick<z.infer<typeof workspaceTarget>, "role" | "mergeQueue"> & { ci?: "workspace" | "actions" }) {
  const permissions: Record<string, "read" | "write"> = {
    issues: "write", pull_requests: "write",
    contents: ["land", "validate"].includes(target.role) ? "write" : "read",
  };
  if (target.role === "validate") permissions.checks = target.ci === "actions" ? "read" : "write";
  if (target.role === "land") {
    permissions.checks = "read";
    if (target.mergeQueue) permissions.merge_queues = "write";
  }
  return permissions;
}

async function finalizeWorkspaceOutputs(
  host: Finalize,
  { locals, origin }: Storage,
  scope: { runId: string; nodeId: string; attemptId: string },
  inputs: Json,
  target: z.infer<typeof workspaceTarget>,
  outputs: Json,
): Promise<Json> {
  // The node's own slot inputs, as the platform sent them for this attempt.
  const event = inputs.event as { issue: { number: number }; sourceRunId?: string };
  let previous = (inputs.previous ?? {}) as Record<string, any>;
  const produced = z
    .object({ ready: z.boolean(), summary: z.string().min(1).max(32000) })
    .passthrough()
    .parse(outputs.result);
  const repo = await host.call("repository.read", {});
  const api = hostAPI((request) => host.call("repository.request", request));
  const forge = foundryForge(api, repo, target.ci === "actions" ? githubActionsAppId : repo.appId);
  if ("merge_group" in event)
    return finalizeMergeGroup(
      forge,
      scope.attemptId,
      target,
      event,
      previous,
      produced,
    );
  if (target.role === "triage")
    return {
      result: {
        ready: produced.ready,
        summary: produced.summary,
        issue: await forge.issue(event.issue.number),
        comment: await forge.comment(
          event.issue.number,
          scope.attemptId,
          produced.summary,
        ),
      },
    };
  const candidate = z
    .object({
      number: z.number().int().positive(),
      headSha: z.string().regex(/^[a-f0-9]{40}$/),
      url: z.string(),
      branch: z.string(),
    })
    .parse(
      ["implement", "repair"].includes(target.role)
        ? produced.candidate
        : previous.candidate,
    );
  const sourceRunId = z.string().uuid().parse(inputs.sourceRunId ?? scope.runId);
  const verified = await forge.change(
    candidate,
    event.issue.number,
    `outfitter/issue-${event.issue.number}-${z.uuid().parse(event.sourceRunId ?? sourceRunId)}`,
    target.role === "land",
  );
  if (requiresDemo(target)) {
    const { evidence, ...demo } = await verifyFoundryDemo(locals, origin, api, repo.name, verified, sourceRunId);
    previous = { ...previous, evidence, demo };
  }
  if (["implement", "repair"].includes(target.role))
    return implementationResult(target.role, previous, produced, verified);
  if (coordinatedRole(target, previous) && target.role !== "land")
    return actionsValidation(host, api, repo.name, forge, target, previous, verified);
  if (target.role === "validate")
    return finalizeValidation(
      forge,
      scope.attemptId,
      target,
      previous,
      produced,
      verified,
    );
  if (target.role === "review")
    return publishIndependentReview(
      host,
      target,
      previous,
      produced,
      verified,
    );
  return landWorkspaceChange(forge, target, previous, verified);
}

function implementationResult(role: string, previous: Record<string, any>, produced: Record<string, any>, verified: ChangeReceipt) {
  const changed = verified.headSha !== previous.candidate?.headSha;
  const skipped = !changed && approvedCandidate(previous);
  return { result: {
    ...previous, candidate: verified,
    ...(role === "repair" ? {
      repair: { status: skipped ? "skipped" : "completed", reason: skipped
        ? "Validation and independent approval pass; no review findings to address."
        : "Addressed validation failures or review findings." },
      summary: skipped ? "Repair skipped: no review findings to address." : produced.summary,
    } : {}),
    ...(changed ? { checks: [], review: null, reviewReuse: null, passed: false } : {}),
  } };
}

async function publishIndependentReview(
  host: Finalize,
  target: z.infer<typeof workspaceTarget>,
  previous: Record<string, any>,
  produced: Record<string, any>,
  verified: ChangeReceipt,
) {
  const verdict = z
    .enum(["approved", "changes-requested"])
    .parse(produced.verdict);
  if (verdict === "approved" && !previous.passed)
    throw new Response("Failed validation cannot be approved", {
      status: 409,
    });
  const review = await host.call("workspace.control", {
    operation: "publish-review",
    reviewer: target.reviewer,
    candidate: { number: verified.number, headSha: verified.headSha },
    verdict,
    summary: produced.summary,
  });
  return { result: { ...previous, candidate: verified, review } };
}

async function landWorkspaceChange(
  forge: FoundryForge,
  target: z.infer<typeof workspaceTarget>,
  previous: Record<string, any>,
  verified: ChangeReceipt,
) {
  if (!previous.passed || previous.review?.verdict !== "approved")
    throw new Response(
      "Review or validation needs attention after the repair pass",
      { status: 422 },
    );
  const merge = await forge.merge(
    verified as ChangeReceipt,
    previous.review as ReviewReceipt,
    target.checks.map((check) => check.name),
    target.mergeQueue,
  );
  if (!merge)
    throw new Response("Waiting for protected merge queue", { status: 425 });
  return { result: { ...previous, merge } };
}

/** The node's produced checks when they are exactly the approved commands, in
 * order (and, for a merge group, all at its head); otherwise null. */
function approvedChecks(produced: Record<string, any>, target: z.infer<typeof workspaceTarget>, headSha?: string) {
  const checks = z.array(z.object({ name: z.string(), headSha: z.string(), passed: z.boolean() })).parse(produced.checks);
  return checks.length === target.checks.length &&
    checks.every((check, index) => check.name === target.checks[index].name && (headSha === undefined || check.headSha === headSha))
    ? checks : null;
}

async function finalizeMergeGroup(
  forge: FoundryForge,
  attemptId: string,
  target: z.infer<typeof workspaceTarget>,
  event: unknown,
  previous: Record<string, any>,
  produced: Record<string, any>,
) {
  const mergeEvent = event as unknown as {
    merge_group: { head_sha: string };
  };
  const checks = approvedChecks(produced, target, mergeEvent.merge_group.head_sha);
  if (target.role !== "validate" || !checks)
    throw new Response(
      "Merge-group validation does not match approved checks",
      { status: 403 },
    );
  return {
    result: {
      ...previous,
      checks: await forge.checks(previous.candidate, checks, attemptId),
      passed: checks.every((check) => check.passed),
    },
  };
}

async function finalizeValidation(
  forge: FoundryForge,
  attemptId: string,
  target: z.infer<typeof workspaceTarget>,
  previous: Record<string, any>,
  produced: Record<string, any>,
  verified: ChangeReceipt,
) {
  const checks = approvedChecks(produced, target);
  if (!checks)
    throw new Response("Validation does not match approved commands", {
      status: 403,
    });
  const passed = checks.every((check) => check.passed);
  if (passed) await forge.ready(verified);
  return {
    result: {
      ...previous,
      candidate: verified,
      checks: await forge.checks(verified, checks, attemptId),
      passed,
      validationFailures: produced.validationFailures ?? [],
    },
  };
}

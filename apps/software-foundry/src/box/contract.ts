// The Foundry box's JSON contract: what goes in (a feature or bug request) and
// what comes out (a run result, the pull request it opened, and a release's
// evidence bundle). The committed JSON Schemas under box/schemas are generated
// from these definitions by scripts/box-schemas.ts.
import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/, "full 40-character commit SHA");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "hex SHA-256");
/** An object stored in the box's RustFS: `s3://<bucket>/<key>`. */
const objectUri = z.string().regex(/^s3:\/\/[a-z0-9.-]+\/.+$/, "s3://bucket/key");
const criterionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const AcceptanceCriterion = z.strictObject({
  id: criterionId,
  text: z.string().min(1).max(2000),
});

export const BugDetails = z.strictObject({
  stepsToReproduce: z.array(z.string().min(1)).min(1).max(50),
  expected: z.string().min(1).max(4000),
  actual: z.string().min(1).max(4000),
  environment: z.string().max(2000).optional(),
});

/** A feature or bug request: the same brief the box reads from /in/requests and
 * Software Foundry's RequestChanges accepts over MCP. */
export const requestBrief = {
  requestId: z.uuid(),
  kind: z.enum(["feature", "bug"]),
  title: z.string().min(1).max(200),
  problem: z.string().min(1).max(20000),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(1).max(50),
  bug: BugDetails.optional(),
};
/** Bug details go with bug requests only; criterion ids are unique. */
export function checkRequestBrief(request: { kind: "feature" | "bug"; bug?: unknown; acceptanceCriteria: { id: string }[] }, context: z.RefinementCtx) {
  if (request.kind === "bug" && !request.bug)
    context.addIssue({ code: "custom", path: ["bug"], message: "bug requests need bug details" });
  if (request.kind === "feature" && request.bug)
    context.addIssue({ code: "custom", path: ["bug"], message: "only bug requests carry bug details" });
  const ids = request.acceptanceCriteria.map((criterion) => criterion.id);
  if (new Set(ids).size !== ids.length)
    context.addIssue({ code: "custom", path: ["acceptanceCriteria"], message: "criterion ids must be unique" });
}

/** One unit of work handed to the box: becomes one issue on the box's forge. */
export const WorkRequest = z
  .strictObject({
    schemaVersion: z.literal(1),
    ...requestBrief,
    /** `pull_request`: reviewed, then merged. `direct_commit`: lands on the default branch. */
    delivery: z.enum(["pull_request", "direct_commit"]).default("pull_request"),
    release: z
      .strictObject({ trigger: z.boolean(), bump: z.enum(["major", "minor", "patch"]).default("patch") })
      .optional(),
    constraints: z
      .strictObject({
        paths: z.array(z.string().min(1)).max(100).optional(),
        maxRepairPasses: z.int().min(0).max(1).default(1),
      })
      .optional(),
  })
  .superRefine(checkRequestBrief);

export const Evidence = z.strictObject({
  kind: z.enum(["screenshot", "log", "report", "artifact"]),
  uri: objectUri,
  sha256,
  criterionId: criterionId.optional(),
  viewport: z.enum(["desktop", "mobile"]).optional(),
  commitSha: sha,
});

export const CheckResult = z.strictObject({
  name: z.string().min(1),
  command: z.string().min(1),
  conclusion: z.enum(["success", "failure", "cancelled", "skipped"]),
  commitSha: sha,
  logUri: objectUri.optional(),
});

export const ReviewResult = z.strictObject({
  verdict: z.enum(["approved", "changes_requested"]),
  reviewer: z.string().min(1),
  commitSha: sha,
});

/** The JSON source of truth for a Foundry pull request; its body is rendered from this. */
export const PullRequest = z.strictObject({
  schemaVersion: z.literal(1),
  number: z.int().positive(),
  url: z.url(),
  title: z.string().min(1).max(200),
  request: z.strictObject({ requestId: z.uuid(), kind: z.enum(["feature", "bug"]), issueNumber: z.int().positive() }),
  baseBranch: z.string().min(1),
  baseSha: sha,
  headBranch: z.string().min(1),
  headSha: sha,
  summary: z.string().min(1).max(20000),
  changes: z.array(z.strictObject({
    path: z.string().min(1),
    change: z.enum(["added", "modified", "deleted", "renamed"]),
    reason: z.string().min(1).max(2000),
  })).min(1),
  acceptanceCriteria: z.array(z.strictObject({
    id: criterionId,
    status: z.enum(["met", "not_met", "unverified"]),
    evidence: z.array(Evidence),
  })).min(1),
  tests: z.array(CheckResult),
  evidence: z.array(Evidence),
  risks: z.array(z.string().min(1)).default([]),
  limitations: z.array(z.string().min(1)).default([]),
  review: ReviewResult.optional(),
  draft: z.boolean(),
});

export const ReleaseArtifact = z.strictObject({
  name: z.string().min(1),
  uri: objectUri,
  sha256,
  bytes: z.int().nonnegative(),
});

/** A release's evidence: what was built, from which commit, and what proves each criterion. */
export const EvidenceBundle = z.strictObject({
  schemaVersion: z.literal(1),
  tag: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  commitSha: sha,
  build: z.strictObject({ command: z.string().min(1), image: z.string().min(1), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime() }),
  model: z.strictObject({ provider: z.enum(["luna", "spark", "replay"]), id: z.string().min(1) }),
  requests: z.array(z.strictObject({
    requestId: z.uuid(),
    pullRequest: z.int().positive().optional(),
    commits: z.array(sha).min(1),
  })).min(1),
  checks: z.array(CheckResult),
  criteria: z.array(z.strictObject({
    requestId: z.uuid(),
    id: criterionId,
    status: z.enum(["met", "not_met", "unverified"]),
    evidence: z.array(Evidence),
  })),
  artifacts: z.array(ReleaseArtifact).min(1),
});

/** Time and model use (box/metrics.mjs): each step's wall time, model calls and tokens; tokens are null when unreported. */
const tokens = z.int().nonnegative().nullable();
export const Metrics = z.strictObject({
  wallSeconds: z.number().nonnegative(),
  modelSeconds: z.number().nonnegative(),
  modelCalls: z.int().nonnegative(),
  inputTokens: tokens,
  outputTokens: tokens,
  outputTokensPerSecond: z.number().nonnegative().nullable(),
  steps: z.array(z.strictObject({
    name: z.string().min(1),
    status: z.string().min(1),
    seconds: z.number().nonnegative(),
    modelCalls: z.int().nonnegative(),
    inputTokens: tokens,
    outputTokens: tokens,
  })),
});

/** Every agent session of the request (box/sessions.mjs): files under sessions/<requestId>/ on the repository's sessions branch, stored with Git LFS. */
export const Sessions = z.strictObject({
  branch: z.string().min(1).optional(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  files: z.array(z.strictObject({ agent: z.string().min(1), path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.int().nonnegative() })),
});

export const RunResult = z
  .strictObject({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    status: z.enum(["landed", "needs_details", "changes_requested", "failed", "refused"]),
    reason: z.string().max(4000).optional(),
    issue: z.strictObject({ number: z.int().positive(), url: z.url() }),
    triage: z.strictObject({ plan: z.string(), questions: z.array(z.string().min(1)) }).optional(),
    change: z
      .discriminatedUnion("delivery", [
        z.strictObject({ delivery: z.literal("pull_request"), pullRequest: PullRequest, mergeSha: sha.optional() }),
        z.strictObject({ delivery: z.literal("direct_commit"), branch: z.string().min(1), commits: z.array(sha).min(1) }),
      ])
      .optional(),
    checks: z.array(CheckResult).default([]),
    review: ReviewResult.optional(),
    release: z.strictObject({
      tag: z.string().min(1),
      url: z.url(),
      artifacts: z.array(ReleaseArtifact).min(1),
      evidenceBundle: z.strictObject({ uri: objectUri, sha256 }),
    }).optional(),
    model: z.strictObject({ provider: z.enum(["luna", "spark", "replay"]), id: z.string().min(1) }),
    usage: z.strictObject({ inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative() }).optional(),
    metrics: Metrics.optional(),
    sessions: Sessions.optional(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
  })
  .superRefine((result, context) => {
    if (result.status === "landed" && !result.change)
      context.addIssue({ code: "custom", path: ["change"], message: "a landed request names its change" });
    if (result.status === "landed" && result.change?.delivery === "pull_request" && !result.change.mergeSha)
      context.addIssue({ code: "custom", path: ["change", "mergeSha"], message: "a landed pull request names its merge commit" });
    if (result.status === "needs_details" && !result.triage?.questions.length)
      context.addIssue({ code: "custom", path: ["triage", "questions"], message: "needs_details carries its questions" });
  });

/** File name → schema, for generation and tests. */
export const boxSchemas = {
  "work-request": WorkRequest,
  "run-result": RunResult,
  "pull-request": PullRequest,
  "evidence-bundle": EvidenceBundle,
} as const;

export function boxJsonSchema(name: keyof typeof boxSchemas) {
  return {
    $id: `https://outfitter.ai/schemas/foundry-box/${name}.schema.json`,
    ...z.toJSONSchema(boxSchemas[name], { io: "input", unrepresentable: "throw" }),
  };
}

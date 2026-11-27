import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { requireAccess, requireOrganization, sha256Hex } from "@ai-outfitter/app-sdk/server";
import { forgejoWorkspaceBranch, type finalizeInput, type OperationOutput, type PhaseInput, type prepareInput, type prepareResult, type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { IntakeContext } from "../intake";
import { forgejoIssueReviewBindings, forgejoIssueReviews } from "../schema";
import { hostAPI } from "./forge";
import { PhaseMismatch, phaseMismatch, readBlobContent, verifyCommitTree, type CommitProof } from "./issue-review-commit";
import { dispatchEffect, newEffect, readyEffect, retryEffect, type ChangeFile, type ReviewEffect } from "./issue-review-effect";

export const issueReviewWorkflow = "foundry-forgejo-issue-review";
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const number = z.number().int().positive();
const repository = z.string().regex(/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const branch = z.string().min(1).max(180).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/)
  .refine(ref => !ref.includes("..") && !ref.startsWith("refs/") && ref !== "HEAD" &&
    ref.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".lock") && !part.endsWith(".")));
export const reviewIssuePins = z.strictObject({
  repository,
  repositoryId: number,
  issueNumber: number,
  baseRef: branch,
  baseSha: sha,
});
const reviewProvider = z.enum(["FORGEJO", "GITHUB"]);
type ReviewProvider = z.infer<typeof reviewProvider>;
const githubUserConnection = "github:user";
const reviewAction = z.enum(["START", "RECOVER", "RESTART"]);
const reviewIssueCommand = z.discriminatedUnion("action", [
  reviewIssuePins.extend({ action: z.literal("START"), provider: reviewProvider }),
  z.strictObject({ action: z.literal("RECOVER"), runId: z.uuid() }),
  z.strictObject({ action: z.literal("RESTART"), runId: z.uuid(), requestId: z.uuid() }),
]);
export const reviewIssueInput = z.strictObject({ input: reviewIssueCommand });
export const reviewIssueGraphInput = reviewIssuePins.partial().extend({
  action: reviewAction, provider: reviewProvider.optional(), runId: z.uuid().optional(), requestId: z.uuid().optional(),
});
const target = reviewIssuePins.extend({
  provider: reviewProvider.optional(),
  origin: z.url(),
  branch,
  workerId: number,
  workerLogin: z.string().regex(/^[a-z0-9][a-z0-9-]*\[bot\]$/).optional(),
  githubInstallationId: number.optional(),
  reviewer: z.string().min(1).max(128),
  reviewerId: number,
}).refine(pins => pins.provider === "GITHUB"
  ? pins.origin === "https://github.com" && !!pins.workerLogin && !!pins.githubInstallationId
  : !pins.workerLogin && !pins.githubInstallationId);
type Target = z.infer<typeof target>;
type Row = typeof forgejoIssueReviews.$inferSelect;
type Repository = OperationOutput<"repository.read">;
type WorkflowRun = NonNullable<OperationOutput<"workflow.read">>;
type Phase = "interactive" | "operator" | "prepare" | "finalize";
const conflict = (reason: string) => new Response(reason, { status: 409 });
const unconfirmed = (reason: string) => new Response(reason, { status: 503 });
const denied = (reason: string) => new Response(reason, { status: 403 });
const actor = z.object({ id: number, login: z.string().min(1) });
const metadata = z.object({ id: number, full_name: repository, html_url: z.url() });

function reviewConnection(snapshot: OperationOutput<"snapshot">, name: string, provider: ReviewProvider) {
  if (provider === "GITHUB") return githubUserConnection;
  const matches = snapshot.connections.filter(connection => connection.owner === "organization" &&
    connection.provider === "forgejo" && connection.operations.includes("issues.read") &&
    connection.repositories.some(listed => listed.toLowerCase() === name.toLowerCase()));
  if (matches.length !== 1) throw denied("An organization Forgejo repository grant is required");
  return matches[0].id;
}

async function repositoryMetadata(host: WorkflowHost<"interactive" | "operator">,
  pins: Pick<Target, "repository" | "repositoryId">, connectionId: string) {
  const repo = metadata.parse(await host.call("repository.request", { connectionId, path: `/repos/${pins.repository}` }));
  const url = new URL(repo.html_url);
  if (repo.id !== pins.repositoryId || repo.full_name.toLowerCase() !== pins.repository.toLowerCase() ||
      !["https:", "http:"].includes(url.protocol))
    throw conflict("The pinned repository changed");
  return { name: repo.full_name, id: repo.id, origin: url.origin };
}

type RepositoryPins = Pick<Target, "repository" | "repositoryId" | "provider" | "workerLogin" | "githubInstallationId">;

function sameRepository(repo: Repository, pins: RepositoryPins, connectionId: string) {
  const github = pins.provider === "GITHUB";
  return repo.forge === (github ? "github" : "forgejo") && repo.checkout === (github ? "github-pinned" : "forgejo-pinned") &&
    repo.inferenceProvider === "spark" && repo.repositoryId === pins.repositoryId &&
    repo.name.toLowerCase() === pins.repository.toLowerCase() &&
    (github ? connectionId === githubUserConnection && !!repo.botLogin &&
      (!pins.workerLogin || pins.workerLogin === repo.botLogin) &&
      (!pins.githubInstallationId || pins.githubInstallationId === repo.installationId) : repo.connectionId === connectionId);
}

function reviewRepository(host: WorkflowHost<Phase>, repo: Repository, bindingId?: string) {
  const api = hostAPI(input => host.call("repository.request", { ...input, bindingId }));
  const github = repo.forge === "github";
  return {
    github,
    get: (suffix: string) => api(`${repo.path}${suffix}`),
    readTree: async (suffix: string) => {
      if (!github || !suffix.startsWith("/git/trees/")) return api(`${repo.path}${suffix}`);
      const tree = z.object({ sha, truncated: z.literal(false), tree: z.array(z.unknown()) })
        .parse(await api(`${repo.path}${suffix.split("?", 1)[0]}`));
      return { ...tree, total_count: tree.tree.length };
    },
    branchPath: (ref: string) => github ? `/git/ref/heads/${ref}` : `/branches/${ref}`,
    createPull: (body: Record<string, string>) => api(`${repo.path}/pulls`, github ? { ...body, draft: true } : body, "POST"),
    createBranch: (name: string, base: string) => github
      ? api(`${repo.path}/git/refs`, { ref: `refs/heads/${name}`, sha: base }, "POST")
      : api(`${repo.path}/branches`, { new_branch_name: name, old_ref_name: base }, "POST"),
    commitFiles: async (body: { branch: string; message: string; files: ChangeFile[] }, baseSha: string) => {
      if (!github) return api(`${repo.path}/contents`, body, "POST");
      const { oid } = await host.call("repository.pinned-commit", {
        expectedHeadSha: baseSha, message: body.message,
        files: body.files.map(file => ({
          path: file.path,
          text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(atob(file.content), char => char.charCodeAt(0))),
        })),
      });
      return { commit: { sha: oid } };
    },
  };
}
type ReviewRepository = ReturnType<typeof reviewRepository>;

function branchSha(api: ReviewRepository, raw: unknown, expected: string, mismatch: typeof conflict) {
  if (api.github) {
    const ref = z.object({ ref: z.string(), object: z.object({ type: z.literal("commit"), sha }) }).parse(raw);
    if (ref.ref === `refs/heads/${expected}`) return ref.object.sha;
  } else {
    const ref = z.object({ name: branch, commit: z.object({ id: sha }) }).parse(raw);
    if (ref.name === expected) return ref.commit.id;
  }
  throw mismatch("Pinned branch identity changed");
}

async function verifySource(api: ReviewRepository, pins: z.infer<typeof reviewIssuePins>, origin?: string,
  mismatch = conflict) {
  const [repositoryResult, base, issueResult] = await Promise.all([
    api.get(""),
    api.get(api.branchPath(pins.baseRef)),
    api.get(`/issues/${pins.issueNumber}`),
  ]);
  const issue = z.object({ number, html_url: z.url(), title: z.string(), state: z.string(),
    body: z.string().nullish(), pull_request: z.unknown().optional() }).parse(issueResult);
  const repo = metadata.parse(repositoryResult);
  const provider = new URL(repo.html_url);
  if (!["https:", "http:"].includes(provider.protocol) || (origin && provider.origin !== origin) ||
      (api.github && provider.origin !== "https://github.com") ||
      repo.id !== pins.repositoryId || repo.full_name.toLowerCase() !== pins.repository.toLowerCase() ||
      new URL(issue.html_url).origin !== provider.origin || issue.number !== pins.issueNumber ||
      issue.pull_request || issue.state !== "open")
    throw mismatch("The pinned repository or open issue changed");
  if (branchSha(api, base, pins.baseRef, mismatch) !== pins.baseSha)
    throw mismatch("The pinned base changed");
  const body = issue.body ?? "";
  return { origin: provider.origin, bodyLimitExceeded: body.length > 16_000,
    issue: { number: issue.number, title: issue.title, url: issue.html_url, body: body.slice(0, 16_000) } };
}

async function savedReview(db: IntakeContext["db"], runId: string) {
  return db().select().from(forgejoIssueReviews).where(eq(forgejoIssueReviews.runId, runId)).get();
}

function savedRecovery(db: IntakeContext["db"], originalId: string) {
  return db().select().from(forgejoIssueReviews).where(eq(forgejoIssueReviews.recoveryOf, originalId)).get();
}

type Pair = typeof forgejoIssueReviewBindings.$inferSelect;
type Role = "implementer" | "reviewer";
const providerKey = (provider: ReviewProvider) => provider === "GITHUB" ? ["github"] : [];
const pairKey = (installationId: string, origin: string, repositoryId: number, provider: ReviewProvider) =>
  sha256Hex(JSON.stringify([installationId, origin, repositoryId, ...providerKey(provider)]));

function selectedPair(db: IntakeContext["db"], key: string) {
  return db().select().from(forgejoIssueReviewBindings).where(eq(forgejoIssueReviewBindings.key, key)).get();
}

async function verifyPair(host: WorkflowHost<"interactive" | "operator">, snapshot: OperationOutput<"snapshot">,
  pins: RepositoryPins, connectionId: string,
  pair: Pick<Pair, "implementer" | "reviewer" | "reviewerName">, expected?: Pick<Pair, "workerId" | "reviewerId">) {
  for (const role of ["implementer", "reviewer"] as const) {
    if (!snapshot.bindings.some(binding => binding.id === pair[role] && binding.workflowId === issueReviewWorkflow &&
        binding.actor === role && binding.kind === "external" && binding.enabled))
      throw denied("The selected actor binding is unavailable");
  }
  if (pair.implementer === pair.reviewer) throw denied("Worker and reviewer bindings must be distinct");
  const [worker, reviewer] = await Promise.all([
    host.call("repository.read", { bindingId: pair.implementer }),
    host.call("repository.read", { bindingId: pair.reviewer }),
  ]);
  if (!sameRepository(worker, pins, connectionId) || !sameRepository(reviewer, pins, connectionId) ||
      reviewer.appId !== worker.appId || reviewer.botLogin !== worker.botLogin ||
      reviewer.installationId !== worker.installationId || (expected && expected.workerId !== worker.appId))
    throw denied("The selected actors no longer cover the pinned repository and writer");
  const principal = actor.parse(await host.call("workspace.control", {
    operation: "inspect-reviewer", bindingId: pair.reviewer, reviewer: pair.reviewerName,
    ...(expected ? { expectedReviewerId: expected.reviewerId } : {}),
  }));
  if ((pins.provider === "GITHUB" ? principal.login.toLowerCase() === worker.botLogin?.toLowerCase() : principal.id === worker.appId) ||
      (expected && principal.id !== expected.reviewerId))
    throw denied("Worker and reviewer must be independent");
  return { worker, reviewerId: principal.id };
}

async function stableRunId(key: readonly unknown[]) {
  const hash = await sha256Hex(JSON.stringify(key));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function publicationReceipt(row: Row) {
  const pins = target.parse(row.inputs["implement.inputs.target"]);
  return {
    target: reviewIssuePins.parse(Object.fromEntries(
      Object.keys(reviewIssuePins.shape).map(key => [key, pins[key as keyof Target]]))),
    candidate: row.candidate,
    ...(row.draftObservation ? { draftObservation: row.draftObservation } : {}),
    review: row.review,
  };
}

function startReceipt(row: Row, status: string, existing: boolean) {
  return { run: { id: row.runId, workflow: issueReviewWorkflow, status, existing }, ...publicationReceipt(row) };
}

function reviewCaller(context: IntakeContext, access: "read" | "write") {
  const identity = requireOrganization(context.identity);
  requireAccess(identity, access);
  if (identity.role === "external" || identity.callerOrganizationId) throw denied("Current organization access required");
  return identity;
}

async function reviewSnapshot(host: WorkflowHost<"interactive">, installationId: string) {
  const snapshot = await host.call("snapshot", {});
  if (snapshot.installation.id !== installationId || !snapshot.installation.workflows.includes(issueReviewWorkflow))
    throw denied("Issue review workflow is unavailable");
  return snapshot;
}

export function reviewForgejoIssue(context: IntakeContext, input: z.infer<typeof reviewIssuePins>) {
  return startIssueReview(context, input, "FORGEJO");
}

async function startIssueReview(context: IntakeContext, input: z.infer<typeof reviewIssuePins>, provider: ReviewProvider) {
  const identity = reviewCaller(context, "write");
  const host = context.host();
  const snapshot = await reviewSnapshot(host, identity.installationId);
  const connectionId = reviewConnection(snapshot, input.repository, provider);
  const metadata = await repositoryMetadata(host, input, connectionId);
  if (provider === "GITHUB" && metadata.origin !== "https://github.com") throw denied("Pinned GitHub origin unavailable");

  const id = await stableRunId([issueReviewWorkflow, identity.installationId, metadata.origin, input.repositoryId,
    input.issueNumber, ...providerKey(provider)]);
  const assignedBranch = forgejoWorkspaceBranch(id);
  if (input.baseRef === assignedBranch) throw conflict("The assigned review branch cannot be its own base");
  const receipt = async (row: Row) => {
    const old = target.parse(row.inputs["implement.inputs.target"]);
    if (old.repository.toLowerCase() !== input.repository.toLowerCase() ||
        old.baseRef !== input.baseRef || old.baseSha !== input.baseSha)
      throw conflict("An existing review run has different immutable pins");
    if (row.inputs["implement.inputs.connectionId"] !== connectionId)
      throw denied("The pinned repository connection changed");
    const run = await host.call("workflow.read", { id });
    if (run) {
      if (run.run.workflowId !== issueReviewWorkflow || canonicalActionValue(run.inputs) !== canonicalActionValue(row.inputs))
        throw conflict("Review workflow identity changed");
      return startReceipt(row, run.run.status, true);
    }
    if (row.createdBy !== identity.userId) throw conflict("The review run is awaiting its original initiator");
    const bindingId = z.string().min(1).parse(row.inputs["implement.inputs.implementerBinding"]);
    const repo = await host.call("repository.read", { bindingId });
    if (!sameRepository(repo, old, connectionId) || repo.appId !== old.workerId)
      throw denied("The pinned execution authority changed");
    await verifySource(reviewRepository(host, repo, bindingId), old, old.origin);
    const started = await host.call("workflow.start", { workflow: issueReviewWorkflow, id, inputs: jsonInputs(row.inputs) });
    return startReceipt(row, "running", !started.created);
  };
  const saved = await savedReview(context.db, id);
  if (saved) return receipt(saved);

  // Read one complete selection. An admission overlapping a reconfiguration
  // freezes this independently verified pair, even if the next issue sees a newer pair.
  const pair = await selectedPair(context.db, await pairKey(identity.installationId, metadata.origin, input.repositoryId, provider));
  if (!pair || pair.connectionId !== connectionId) throw denied("Configure the issue review bindings for this repository");
  const { worker } = await verifyPair(host, snapshot, { ...input, provider }, connectionId, pair, pair);
  const pins = { ...input, repository: worker.name };
  const { origin, issue } = await verifySource(reviewRepository(host, worker, pair.implementer), pins, metadata.origin);
  const inputs = {
    "implement.inputs.target": { ...pins, origin, branch: assignedBranch,
      ...(provider === "GITHUB" ? { provider, workerLogin: worker.botLogin, githubInstallationId: worker.installationId } : {}),
      workerId: pair.workerId, reviewer: pair.reviewerName, reviewerId: pair.reviewerId },
    "implement.inputs.issue": issue,
    "implement.inputs.connectionId": connectionId,
    "implement.inputs.implementerBinding": pair.implementer,
    "implement.inputs.reviewerBinding": pair.reviewer,
  };
  const [claimed] = await context.db().insert(forgejoIssueReviews).values({
    runId: id, installationId: identity.installationId, repositoryId: input.repositoryId,
    forgeOrigin: origin, issueNumber: input.issueNumber,
    createdBy: identity.userId, inputs,
  }).onConflictDoNothing().returning();
  const row = claimed ?? await savedReview(context.db, id);
  if (!row) throw conflict("Review run claim unavailable");
  return receipt(row);
}

function jsonInputs(input: Record<string, unknown>) {
  return z.record(z.string(), z.json()).parse(input);
}

export const issueReviewRunInput = z.strictObject({ runId: z.uuid() });

export async function reviewIssue(context: IntakeContext, command: z.infer<typeof reviewIssueCommand>) {
  if (command.action === "RECOVER") return recoverIssueReview(context, command.runId);
  if (command.action === "RESTART") return continueIssueReview(context, command.runId, command.requestId);
  const { action, provider, ...pins } = command;
  const receipt = await startIssueReview(context, pins, provider);
  return readIssueReview(context, receipt.run.id);
}

async function reviewRun(context: IntakeContext, runId: string, access: "read" | "write", originalOnly = false) {
  const identity = reviewCaller(context, access);
  const row = await savedReview(context.db, runId);
  if (!row || (originalOnly && row.recoveryOf !== null) || row.installationId !== identity.installationId)
    throw new Response("Original issue review not found", { status: 404 });
  return { identity, row };
}

async function readReviewRun(host: WorkflowHost<"interactive">, row: Row) {
  const run = await host.call("workflow.read", { id: row.runId });
  if (run && (run.run.id !== row.runId || run.run.workflowId !== issueReviewWorkflow ||
      run.run.createdBy !== row.createdBy || canonicalActionValue(run.inputs) !== canonicalActionValue(row.inputs)))
    throw conflict("Review workflow identity changed");
  return run;
}

function runHistory(run: WorkflowRun | null, row: Row) {
  return run
    ? { id: run.run.id, status: run.run.status, attempts: run.attempts }
    : { id: row.runId, status: "pending", attempts: [] };
}

function sameLineage(left: Row, right: Row) {
  return left.installationId === right.installationId && left.createdBy === right.createdBy &&
    left.repositoryId === right.repositoryId && left.issueNumber === right.issueNumber && left.forgeOrigin === right.forgeOrigin;
}

async function reviewAncestors(db: IntakeContext["db"], row: Row) {
  const ancestors = [row];
  const seen = new Set([row.runId]);
  for (let id = row.recoveryOf; id !== null;) {
    if (seen.has(id)) throw conflict("Review lineage changed");
    const parent = await savedReview(db, id);
    if (!parent || !sameLineage(parent, row))
      throw conflict("Review lineage changed");
    ancestors.push(parent);
    seen.add(id);
    id = parent.recoveryOf;
  }
  return ancestors.reverse();
}

async function reviewHistory(host: WorkflowHost<"interactive">, rows: Row[], callerId: string) {
  const runs = await Promise.all(rows.map(row => readReviewRun(host, row)));
  if (rows[0].createdBy !== callerId && runs.some(run => !run))
    throw new Response("Issue review not available", { status: 404 });
  const history = rows.map((row, index) => runHistory(runs[index], row));
  const latest = rows[rows.length - 1];
  return {
    provider: target.parse(rows[0].inputs["implement.inputs.target"]).provider ?? "FORGEJO",
    original: history[0],
    recovery: history.length > 1 ? history[history.length - 1] : null,
    ...(history.length > 2 ? { lineage: history } : {}),
    ...publicationReceipt(latest),
  };
}

export async function readIssueReview(context: IntakeContext, runId: string) {
  const { row, identity } = await reviewRun(context, runId, "read");
  const lineage = await reviewAncestors(context.db, row);
  const seen = new Set(lineage.map(item => item.runId));
  for (let child = await savedRecovery(context.db, row.runId); child; child = await savedRecovery(context.db, child.runId)) {
    if (seen.has(child.runId) || !sameLineage(child, row))
      throw conflict("Review lineage changed");
    lineage.push(child);
    seen.add(child.runId);
  }
  return reviewHistory(context.host(), lineage, identity.userId);
}

// Compatibility with retained failures created before recovery was available.
const checkoutInitializationFailure = "Pinned checkout could not initialize.";

function requirePreCheckoutFailure(row: Row, run: WorkflowRun | null) {
  const attempt = run?.attempts[0];
  // The host records this exact runtime-owned error only when its pinned
  // checkout worker exits during initialization, before it launches an agent.
  if (run?.run.status !== "failed" || run.attempts.length !== 1 || attempt?.nodeId !== "implement" ||
      attempt.state !== "failed" || attempt.failure !== checkoutInitializationFailure ||
      attempt.sessionArtifact?.runId !== row.runId || Object.keys(run.outputs).length ||
      row.effectDispatch || row.branchClaim || row.commitClaim || row.commitProof || row.publication ||
      row.draftObservation || row.candidate || row.reviewPublication || row.review)
    throw conflict("Continuation requires retained pre-checkout failures and no publication claims");
}

export function recoverIssueReview(context: IntakeContext, runId: string) {
  return continueIssueReview(context, runId);
}

async function continueIssueReview(context: IntakeContext, runId: string, requestId?: string) {
  const { identity, row } = await reviewRun(context, runId, "write", !requestId);
  if (row.createdBy !== identity.userId) throw denied("Only the original review initiator can continue this run");
  const host = context.host();
  const lineage = await reviewAncestors(context.db, row);
  const root = lineage[0];
  const pins = target.parse(row.inputs["implement.inputs.target"]);
  const provider = pins.provider ?? "FORGEJO";
  const pinnedIdentity = (item: Row) => {
    const { branch: assigned, ...source } = target.parse(item.inputs["implement.inputs.target"]);
    if (assigned !== forgejoWorkspaceBranch(item.runId)) throw conflict("Review lineage branch changed");
    return canonicalActionValue(source);
  };
  const sourceIdentity = pinnedIdentity(row);
  if (pins.origin !== row.forgeOrigin || pins.repositoryId !== row.repositoryId || pins.issueNumber !== row.issueNumber ||
      root.runId !== await stableRunId([issueReviewWorkflow, row.installationId, row.forgeOrigin, row.repositoryId, row.issueNumber,
        ...providerKey(provider)]) || lineage.some(item => pinnedIdentity(item) !== sourceIdentity))
    throw conflict("The original review pins changed");

  const continuationKey = requestId ? ["restart", row.installationId, runId, requestId.toLowerCase()] : ["recovery", row.installationId, runId];
  const recoveryId = await stableRunId([issueReviewWorkflow, ...continuationKey]);
  const recoveryPins = { ...pins, branch: forgejoWorkspaceBranch(recoveryId) };
  if (recoveryPins.branch === pins.baseRef) throw conflict("The continuation branch cannot be its own base");
  const inputs: Row["inputs"] = { ...row.inputs, "implement.inputs.target": recoveryPins };
  const matchesInputs = (saved: Row) => {
    // RESTART may have already captured its issue snapshot before an earlier
    // response was lost. That durable input belongs to the request ID.
    const expected = requestId ? { ...inputs, "implement.inputs.issue": saved.inputs["implement.inputs.issue"] } : inputs;
    return canonicalActionValue(saved.inputs) === canonicalActionValue(expected);
  };
  const existingRecovery = async () => {
    const saved = await savedRecovery(context.db, runId);
    if (saved && (saved.runId !== recoveryId || saved.installationId !== row.installationId ||
        saved.createdBy !== row.createdBy || !matchesInputs(saved)))
      throw conflict("This run already has a different continuation");
    return saved;
  };
  const report = (child: Row) => reviewHistory(host, [...lineage, child], identity.userId);
  let recovery = await existingRecovery();
  if (recovery && await readReviewRun(host, recovery)) return report(recovery);
  const priorRuns = await Promise.all(lineage.map(item => readReviewRun(host, item)));
  lineage.forEach((item, index) => requirePreCheckoutFailure(item, priorRuns[index]));

  const snapshot = await reviewSnapshot(host, identity.installationId);
  const connectionId = reviewConnection(snapshot, pins.repository, provider);
  if (row.inputs["implement.inputs.connectionId"] !== connectionId)
    throw denied("The pinned repository connection changed");
  const implementer = z.string().min(1).parse(row.inputs["implement.inputs.implementerBinding"]);
  const reviewer = z.string().min(1).parse(row.inputs["implement.inputs.reviewerBinding"]);
  const { worker } = await verifyPair(host, snapshot, pins, connectionId, { implementer, reviewer, reviewerName: pins.reviewer },
    { workerId: pins.workerId, reviewerId: pins.reviewerId });

  const api = reviewRepository(host, worker, implementer);
  const branches = [...lineage.map(item => forgejoWorkspaceBranch(item.runId)), recoveryPins.branch];
  try {
    const { issue, bodyLimitExceeded } = await verifySource(api, pins, pins.origin);
    const previous = z.object({ number, url: z.url() }).parse(row.inputs["implement.inputs.issue"]);
    if (issue.number !== previous.number || issue.url !== previous.url)
      throw conflict("The original issue identity changed");
    // An existing claim owns a frozen work order. A lost start can be replayed
    // after rechecking identity, authorization, and provider publication state.
    if (!recovery) {
      if (requestId) {
        if (bodyLimitExceeded) throw conflict("The current issue body exceeds 16000 characters");
        inputs["implement.inputs.issue"] = issue;
      } else if (canonicalActionValue(issue) !== canonicalActionValue(row.inputs["implement.inputs.issue"])) {
        throw conflict("The original issue changed");
      }
    }
    const [tips, priorPull] = await Promise.all([
      Promise.all(branches.map(branch => reviewBranchTip(api, { ...pins, branch }))),
      hasReviewPull(api, pins, branches, [...lineage.map(item => item.runId), recoveryId]),
    ]);
    if (tips.some(Boolean) || priorPull) throw conflict("The provider already has publication evidence for this review");
  } catch (error) {
    const saved = await existingRecovery();
    if (saved && await readReviewRun(host, saved)) return report(saved);
    throw error;
  }

  if (!recovery) {
    const [claimed] = await context.db().insert(forgejoIssueReviews).values({
      runId: recoveryId, recoveryOf: runId, installationId: row.installationId, repositoryId: row.repositoryId,
      issueNumber: row.issueNumber, forgeOrigin: row.forgeOrigin, createdBy: row.createdBy, inputs,
    }).onConflictDoNothing().returning();
    recovery = claimed ?? await existingRecovery();
    if (!recovery) throw conflict("Review continuation claim unavailable");
  }
  await host.call("workflow.start", { workflow: issueReviewWorkflow, id: recovery.runId, inputs: jsonInputs(recovery.inputs) });
  return report(await existingRecovery() ?? recovery);
}

const head = z.object({ ref: branch, sha, repo: z.object({ id: number, full_name: repository }) });
const pull = z.object({
  number,
  html_url: z.url(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullish(),
  draft: z.boolean().optional(),
  user: z.object({ id: number, login: z.string().optional(), type: z.string().optional() }),
  base: head,
  head,
});
const sourcePath = z.string().max(500).regex(/^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/)
  .refine(path => !path.includes("..") && !path.split("/").some(part => part === "." || part.toLowerCase() === ".git"))
  .refine(path => !/^\.(?:forgejo|gitea|github)\/workflows(?:\/|$)/i.test(path));
const changes = z.strictObject({
  summary: z.string().trim().min(1).max(16_000),
  files: z.array(z.strictObject({ path: sourcePath, content: z.string().max(100_000) })).min(1).max(20),
}).refine(({ files }) => new Set(files.map(file => file.path)).size === files.length &&
  files.reduce((total, file) => total + new TextEncoder().encode(file.content ?? "").length, 0) <= 100_000);
type Changes = z.infer<typeof changes>;

const implemented = z.object({ headSha: sha, summary: z.string().trim().min(1).max(16_000) });
const reviewed = implemented.extend({ verdict: z.enum(["approved", "changes-requested"]) });
const candidateReceipt = z.object({ number, url: z.url(), headSha: sha, branch, authorId: number });
const reviewReceipt = z.object({ id: number, url: z.url(), headSha: sha, verdict: reviewed.shape.verdict, reviewer: actor });
type Candidate = z.infer<typeof candidateReceipt>;
const marker = (runId: string) => `<!-- outfitter:issue-review:${runId} -->`;
const reviewMarker = (attemptId: string) => `<!-- outfitter:workspace-review:${attemptId} -->`;

function writerDraft(current: z.infer<typeof pull>, pins: Target) {
  if (pins.provider !== "GITHUB") return current.merged === false && /^WIP: /i.test(current.title) && current.user.id === pins.workerId;
  return current.draft === true && !current.merged && !current.merged_at &&
    current.user.type === "Bot" && current.user.login?.toLowerCase() === pins.workerLogin?.toLowerCase();
}

function verifyPull(current: z.infer<typeof pull>, pins: Target, headSha: string, runId: string): Candidate {
  const same = (ref: z.infer<typeof head>) => ref.repo.id === pins.repositoryId &&
    ref.repo.full_name.toLowerCase() === pins.repository.toLowerCase();
  if (current.state !== "open" || !writerDraft(current, pins) ||
      !same(current.base) || !same(current.head) || current.base.ref !== pins.baseRef ||
      current.base.sha !== pins.baseSha || current.head.ref !== pins.branch || current.head.sha !== headSha ||
      !current.body?.includes(marker(runId)) ||
      new URL(current.html_url).origin !== pins.origin)
    throw phaseMismatch("The draft pull request no longer matches its pinned repository, base, head or author");
  return { number: current.number, url: current.html_url, headSha, branch: pins.branch, authorId: current.user.id };
}

async function* pullHistory(api: ReviewRepository, pins: Target, headRef = pins.branch) {
  const [owner] = pins.repository.split("/");
  const query = api.github ? `per_page=50&head=${encodeURIComponent(`${owner}:${headRef}`)}` : "limit=50";
  for (let page = 1; page <= 20; page++) {
    const items = z.array(z.unknown()).parse(await api.get(`/pulls?state=all&${query}&page=${page}`));
    yield* items;
    if (items.length < 50) return;
  }
  throw unconfirmed("Pull request history exceeds the reconciliation limit");
}

const pullIdentity = z.object({
  body: z.string().nullish(),
  head: z.object({ ref: z.string(), repo: z.object({ id: number }).nullable() }),
});

async function hasReviewPull(api: ReviewRepository, pins: Target, branches: string[], runs: string[]) {
  for (const headRef of api.github ? branches : [pins.branch]) {
    for await (const item of pullHistory(api, pins, headRef)) {
      const match = pullIdentity.safeParse(item);
      if (!match.success) throw unconfirmed("Pull history contains an unreadable record");
      const { body, head } = match.data;
      if (runs.some(id => body?.includes(marker(id))) ||
          (branches.includes(head.ref) && (!head.repo || head.repo.id === pins.repositoryId))) return true;
    }
  }
  return false;
}

async function findPull(api: ReviewRepository, pins: Target) {
  let found: z.infer<typeof pull> | undefined;
  for await (const item of pullHistory(api, pins)) {
    const match = pullIdentity.safeParse(item);
    if (match.success && match.data.head.ref === pins.branch && match.data.head.repo?.id === pins.repositoryId) {
      const { number: pullNumber } = z.object({ number }).parse(item);
      if (found?.number === pullNumber) continue;
      if (found) throw phaseMismatch("The review branch has multiple pull requests");
      found = pull.parse(api.github ? await api.get(`/pulls/${pullNumber}`) : item);
    }
  }
  return found;
}

async function optionalRead(api: ReviewRepository, suffix: string) {
  try {
    return await api.get(suffix);
  } catch (error) {
    if (error instanceof Response && error.status === 404) return null;
    throw error;
  }
}

const commitMessage = (pins: Target, runId: string, proof: CommitProof) =>
  `Implement ${pins.provider === "GITHUB" ? "GitHub" : "Forgejo"} issue review ${runId} ${proof.nonce}`;
const gitCommit = z.object({
  sha,
  commit: z.object({ message: z.string(), tree: z.object({ sha }),
    verification: z.object({ verified: z.boolean() }).optional() }),
  parents: z.array(z.object({ sha })),
  author: z.object({ id: number, login: z.string().optional(), type: z.string().optional() }).nullish(),
  committer: z.object({ id: number }).nullish(),
});
const commitPath = (api: ReviewRepository, revision: string) => api.github
  ? `/commits/${revision}?per_page=1&page=1` : `/git/commits/${revision}?stat=false&files=false`;

async function reviewBranchTip(api: ReviewRepository, pins: Target, required = false) {
  const path = api.branchPath(pins.branch);
  const tip = required ? await api.get(path) : await optionalRead(api, path);
  if (tip === null && !required) return null;
  return branchSha(api, tip, pins.branch, phaseMismatch);
}

function requireCommitProof(row: Row) {
  if (!row.commitProof) throw phaseMismatch("The commit has no durable file proof");
  return row.commitProof;
}

async function stagedCommit(api: ReviewRepository, pins: Target, row: Row) {
  const proof = requireCommitProof(row);
  const headSha = await reviewBranchTip(api, pins);
  const expectedHead = row.publication?.headSha ?? proof.headSha;
  if (expectedHead && expectedHead !== headSha) throw phaseMismatch("The pinned implementation commit changed");
  if (!headSha || headSha === pins.baseSha) throw unconfirmed("Commit publication is unconfirmed; reconciling the run branch");
  const headTree = await verifyCommit(api, pins, headSha, row.runId, proof);
  const base = gitCommit.parse(await api.get(commitPath(api, pins.baseSha)));
  if (base.sha !== pins.baseSha) throw phaseMismatch("The pinned commit identity changed");
  await verifyCommitTree(api.readTree, base.commit.tree.sha, headTree, proof);
  return { headSha, proof };
}

async function verifyCommit(api: ReviewRepository, pins: Target, headSha: string, runId: string, proof: CommitProof) {
  const [tip, commit] = await Promise.all([reviewBranchTip(api, pins, true), api.get(commitPath(api, headSha))]);
  const object = gitCommit.parse(commit);
  if (tip !== headSha || object.sha !== headSha ||
      object.commit.message.trim() !== commitMessage(pins, runId, proof) || object.parents.length !== 1 ||
      object.parents[0].sha !== pins.baseSha)
    throw phaseMismatch("The review branch must contain the verified commit directly on the pinned base");
  const authorMatches = pins.provider === "GITHUB"
    ? object.commit.verification?.verified === true && object.author?.type === "Bot" &&
      object.author.login?.toLowerCase() === pins.workerLogin?.toLowerCase()
    : object.author?.id === pins.workerId && object.committer?.id === pins.workerId;
  if (!authorMatches) throw phaseMismatch("The commit was not attributed to the pinned writer");
  return object.commit.tree.sha;
}

function retryUnknownDraftRead(error: unknown): never {
  // The platform settles these statuses. Broker refusals do not establish
  // a mismatch, even when they use the same status as a typed comparison.
  if (error instanceof Response && !(error instanceof PhaseMismatch) && [400, 403, 404, 409, 422].includes(error.status))
    throw unconfirmed("Draft reconciliation read is unavailable");
  throw error;
}

type Node = z.infer<typeof prepareInput> | z.infer<typeof finalizeInput>;
async function phaseSource(host: WorkflowHost<"prepare" | "finalize">, db: IntakeContext["db"], phase: Node) {
  const { node, inputs } = phase;
  if (!["implement", "review"].includes(node.nodeId) || phase.settings.policy !== issueReviewWorkflow)
    throw denied("An admitted review run is required");
  const row = await savedReview(db, node.runId);
  if (!row) throw denied("An admitted review run is required");
  const reconcilingDraft = node.nodeId === "implement" && row.publication && !row.candidate;
  const run = await host.call("workflow.read", { id: node.runId }).catch(error => {
    if (reconcilingDraft) retryUnknownDraftRead(error);
    throw error;
  });
  if (run?.run.workflowId !== issueReviewWorkflow || canonicalActionValue(run.inputs) !== canonicalActionValue(row.inputs))
    throw phaseMismatch("The admitted review run identity changed");
  const pins = target.parse(row.inputs["implement.inputs.target"]);
  const supplied = target.parse(inputs.target);
  if (pins.branch !== forgejoWorkspaceBranch(node.runId) || JSON.stringify(supplied) !== JSON.stringify(pins)) throw phaseMismatch("Workflow target pins changed");
  const role = node.nodeId === "implement" ? "implementer" : "reviewer";
  if (phase.settings.role !== role || (role === "reviewer" && phase.settings.reviewer !== pins.reviewer))
    throw phaseMismatch("The approved execution role changed");
  const bindingId = z.string().min(1).parse(row.inputs[`implement.inputs.${role}Binding`]);
  const repo = await host.call("repository.read", { bindingId }).catch(error => {
    if (reconcilingDraft) retryUnknownDraftRead(error);
    throw error;
  });
  const connectionId = z.string().min(1).parse(row.inputs["implement.inputs.connectionId"]);
  if (!sameRepository(repo, pins, connectionId) || repo.appId !== pins.workerId)
    throw phaseMismatch("The pinned execution authority changed");
  const api = reviewRepository(host, repo);
  // A claimed draft must reconcile before a ref-drift refusal can terminate it.
  if (!reconcilingDraft)
    await verifySource(api, pins, pins.origin, phaseMismatch);
  return { row, pins, api };
}

async function verifyReviewer(host: WorkflowHost<"prepare" | "finalize">, pins: Target, candidate: Candidate) {
  const result = actor.parse(await host.call("workspace.control", {
    operation: "inspect-reviewer", reviewer: pins.reviewer, expectedReviewerId: pins.reviewerId,
    candidate: { number: candidate.number, headSha: candidate.headSha },
  }));
  if (result.id !== pins.reviewerId || result.id === candidate.authorId)
    throw phaseMismatch("The pinned independent reviewer changed");
}

async function currentCandidate(api: ReviewRepository, row: Row, pins: Target) {
  const saved = candidateReceipt.parse(row.candidate);
  await verifyCommit(api, pins, saved.headSha, row.runId, requireCommitProof(row));
  const current = verifyPull(pull.parse(await api.get(`/pulls/${saved.number}`)), pins, saved.headSha, row.runId);
  if (current.number !== saved.number || current.authorId !== saved.authorId)
    throw phaseMismatch("The pinned pull request changed");
  return current;
}

export async function prepareIssueReview(host: WorkflowHost<"prepare">, db: IntakeContext["db"],
  phase: z.infer<typeof prepareInput>): Promise<z.input<typeof prepareResult>> {
  const { row, pins, api } = await phaseSource(host, db, phase);
  if (phase.node.nodeId === "implement") {
    if (row.commitClaim || row.publication || row.effectDispatch?.kind === "branch") return { mode: "coordinator" };
    return {
      mode: "agent", role: "implement", checkout: { sha: pins.baseSha },
      guidance: [
        `Work in the local repo checkout from ${pins.baseRef} at ${pins.baseSha}. Check that exact revision before editing.`,
        "Propose complete text for added or updated files, with your check summary. This workflow supports no deletions or renames.",
      ],
    };
  }
  const candidate = await currentCandidate(api, row, pins);
  await verifyReviewer(host, pins, candidate);
  if (row.reviewPublication) return { mode: "coordinator" };
  return {
    mode: "agent", role: "review", checkout: { sha: candidate.headSha, baseSha: pins.baseSha },
    guidance: [
      `In the local repo checkout, compare ${pins.baseSha} to ${candidate.headSha} with git diff. Track actual check outcomes.`,
      "Foundry submits the formal review.",
    ],
  };
}

async function fileOperation(api: ReviewRepository, pins: Target, file: Changes["files"][number]): Promise<ChangeFile | null> {
  const { path, content } = file;
  const previous = await optionalRead(api, `/contents/${path}?ref=${pins.baseSha}`);
  const existing = previous === null ? null : z.object({ type: z.literal("file"), sha }).parse(previous);
  const encoded = btoa(Array.from(new TextEncoder().encode(content), byte => String.fromCharCode(byte)).join(""));
  if (!existing) return { operation: "create", path, content: encoded };
  if (await readBlobContent(api.get, existing.sha) === encoded) return null;
  return { operation: "update", path, sha: existing.sha, content: encoded };
}

async function publishBranch(db: IntakeContext["db"], { row, pins, api }: Awaited<ReturnType<typeof phaseSource>>,
  phase: z.infer<typeof finalizeInput>) {
  const { runId, attemptId } = phase.node;
  if (row.commitClaim) {
    const ready = readyEffect(row.effectDispatch, "commit");
    if (!ready || await reviewBranchTip(api, pins) !== pins.baseSha) return stagedCommit(api, pins, row);
    await verifySource(api, pins, pins.origin, phaseMismatch);
    const effect = await retryEffect(db, runId, ready);
    return effect ? publishCommit(db, api, pins, row, effect) : stagedCommit(api, pins, row);
  }

  let branchEffect = row.effectDispatch?.kind === "branch" ? row.effectDispatch : null;
  if (!branchEffect) {
    if (phase.coordinator) throw phaseMismatch("An implementation result is required");
    const proposed = changes.safeParse(phase.outputs.result);
    if (!proposed.success) throw phaseMismatch("Implementation must propose a bounded set of added or updated text files");
    const files: ChangeFile[] = [];
    for (const proposedFile of proposed.data.files) {
      const file = await fileOperation(api, pins, proposedFile);
      if (file) files.push(file);
    }
    if (!files.length) throw phaseMismatch("Implementation proposal leaves the pinned base unchanged");
    branchEffect = newEffect("branch", { branch: pins.branch, base: pins.baseSha, files, summary: proposed.data.summary });
  }

  const { branch: branchName, base, files, summary } = branchEffect.payload;
  const tip = await reviewBranchTip(api, pins);
  if (!row.branchClaim) {
    if (tip) throw phaseMismatch("The assigned branch already exists");
    await verifySource(api, pins, pins.origin, phaseMismatch);
    const [claimed] = await db().update(forgejoIssueReviews).set({ branchClaim: attemptId, effectDispatch: branchEffect })
      .where(and(eq(forgejoIssueReviews.runId, runId), isNull(forgejoIssueReviews.branchClaim))).returning();
    if (!claimed) throw unconfirmed("Another finalizer claimed the branch");
    await dispatchEffect(db, runId, branchEffect, () => api.createBranch(branchName, base));
  } else if (!tip && branchEffect.retryable) {
    await verifySource(api, pins, pins.origin, phaseMismatch);
    const effect = await retryEffect(db, runId, branchEffect);
    if (effect) await dispatchEffect(db, runId, effect, () => api.createBranch(branchName, base));
  }
  const currentTip = await reviewBranchTip(api, pins);
  if (currentTip !== pins.baseSha) {
    const latest = await savedReview(db, runId);
    if (latest?.commitClaim) return stagedCommit(api, pins, latest);
    if (currentTip) throw phaseMismatch("The assigned branch does not point at the pinned base");
    throw unconfirmed("Branch creation is unconfirmed at the pinned base");
  }
  const proof: CommitProof = {
    summary,
    nonce: crypto.randomUUID(),
    files: await Promise.all(files.map(async file => ({
      path: file.path, beforeSha: file.sha ?? null,
      contentHash: await sha256Hex(file.content),
    }))),
  };
  if (await reviewBranchTip(api, pins) !== pins.baseSha) {
    const latest = await savedReview(db, runId);
    if (latest?.commitClaim) return stagedCommit(api, pins, latest);
    throw phaseMismatch("The assigned branch moved before committing");
  }
  await verifySource(api, pins, pins.origin, phaseMismatch);
  const effect = newEffect("commit", { branch: branchName, message: commitMessage(pins, runId, proof), files });
  const [claimed] = await db().update(forgejoIssueReviews).set({ commitClaim: attemptId, commitProof: proof, effectDispatch: effect })
    .where(and(eq(forgejoIssueReviews.runId, runId), isNull(forgejoIssueReviews.commitClaim))).returning();
  if (claimed) return publishCommit(db, api, pins, claimed, effect);
  const current = await savedReview(db, runId);
  if (!current) throw phaseMismatch("The durable commit claim changed");
  return stagedCommit(api, pins, current);
}

async function publishCommit(db: IntakeContext["db"], api: ReviewRepository, pins: Target, row: Row,
  effect: ReviewEffect<"commit">) {
  const written = await dispatchEffect(db, row.runId, effect, () => api.commitFiles(effect.payload, pins.baseSha));
  const receipt = z.object({ commit: z.object({ sha }) }).safeParse(written);
  if (receipt.success) {
    const proof = { ...requireCommitProof(row), headSha: receipt.data.commit.sha };
    await db().update(forgejoIssueReviews).set({ commitProof: proof })
      .where(and(eq(forgejoIssueReviews.runId, row.runId), eq(forgejoIssueReviews.effectDispatch, effect)));
    row = { ...row, commitProof: proof };
  }
  return stagedCommit(api, pins, row);
}

/** A blocked observation establishes identity, not acceptance of the refs. */
function ownedDraft(current: z.infer<typeof pull>, pins: Target, runId: string) {
  return current.head.repo.id === pins.repositoryId && current.base.repo.id === pins.repositoryId &&
    current.head.repo.full_name.toLowerCase() === pins.repository.toLowerCase() &&
    current.base.repo.full_name.toLowerCase() === pins.repository.toLowerCase() &&
    current.head.ref === pins.branch && writerDraft(current, pins) &&
    current.body?.includes(marker(runId)) &&
    new URL(current.html_url).origin === pins.origin;
}

async function publishCandidate(db: IntakeContext["db"], source: Awaited<ReturnType<typeof phaseSource>>,
  phase: z.infer<typeof finalizeInput>) {
  const { row, pins, api } = source;
  const { attemptId, runId } = phase.node;
  if (row.candidate) {
    return { candidate: await currentCandidate(api, row, pins), summary: requireCommitProof(row).summary };
  }
  if (row.draftObservation?.status === "blocked")
    throw phaseMismatch(String(row.draftObservation.reason));

  let claim = row.publication;
  let proof = row.commitProof;
  let observed: z.infer<typeof pull> | undefined;
  const sendDraft = async (effect: ReviewEffect<"draft">) => {
    const created = pull.safeParse(await dispatchEffect(db, runId, effect, () => api.createPull(effect.payload)));
    if (created.success && ownedDraft(created.data, pins, runId)) observed = created.data;
  };
  if (!claim) {
    const staged = await publishBranch(db, source, phase);
    proof = staged.proof;
    const existing = await findPull(api, pins);
    if (existing) {
      claim = (await savedReview(db, runId))?.publication ?? null;
      if (claim?.headSha !== staged.headSha) throw phaseMismatch("The assigned branch already has a pull request");
    } else {
      await verifyCommit(api, pins, staged.headSha, runId, proof);
      await verifySource(api, pins, pins.origin, phaseMismatch);
      const next = { attemptId, headSha: staged.headSha };
      const effect = newEffect("draft", {
        head: pins.branch,
        base: pins.baseRef,
        title: `${api.github ? "" : "WIP: "}Review for issue #${pins.issueNumber}`,
        body: `Review of issue #${pins.issueNumber}.\n\n${marker(runId)}`,
      });
      const [claimed] = await db().update(forgejoIssueReviews).set({ publication: next, effectDispatch: effect,
        draftObservation: { status: "ambiguous", branch: pins.branch, expectedHeadSha: next.headSha, expectedBaseSha: pins.baseSha },
      }).where(and(eq(forgejoIssueReviews.runId, runId), isNull(forgejoIssueReviews.publication))).returning();
      claim = claimed ? next : (await savedReview(db, runId))?.publication ?? null;
      if (claimed) await sendDraft(effect);
    }
  }
  if (!claim || !proof) throw phaseMismatch("The durable draft claim changed");
  const expectedHeadSha = claim.headSha;

  const observation = (status: "ambiguous" | "blocked", reason?: string) => ({
    status, branch: pins.branch, expectedHeadSha: claim.headSha, expectedBaseSha: pins.baseSha,
    ...(observed ? { number: observed.number, url: observed.html_url, headSha: observed.head.sha,
      baseRef: observed.base.ref, baseSha: observed.base.sha, state: observed.state }
      : row.draftObservation?.number ? {
        number: row.draftObservation.number, url: row.draftObservation.url, headSha: row.draftObservation.headSha,
        baseRef: row.draftObservation.baseRef, baseSha: row.draftObservation.baseSha, state: row.draftObservation.state,
      } : {}),
    ...(reason ? { reason } : {}),
  });
  const draftPending = and(eq(forgejoIssueReviews.runId, runId), isNull(forgejoIssueReviews.candidate),
    sql`coalesce(json_extract(${forgejoIssueReviews.draftObservation}, '$.status'), '') <> 'blocked'`);
  const saveObservation = (value: ReturnType<typeof observation>) => db().update(forgejoIssueReviews)
    .set({ draftObservation: value }).where(draftPending);

  const checkObserved = async () => {
    if (observed) {
      await saveObservation(observation("ambiguous"));
      // A returned exact-run draft with stale refs is evidence of a conflict.
      verifyPull(observed, pins, expectedHeadSha, runId);
    }
  };

  try {
    await checkObserved();
    let existing = await findPull(api, pins);
    const ready = readyEffect(row.effectDispatch, "draft");
    if (!existing && ready) {
      await verifySource(api, pins, pins.origin, phaseMismatch);
      await verifyCommit(api, pins, claim.headSha, runId, proof);
      const effect = await retryEffect(db, runId, ready);
      if (effect) {
        await sendDraft(effect);
        await checkObserved();
      }
      existing = await findPull(api, pins);
    }
    if (existing && !ownedDraft(existing, pins, runId))
      throw phaseMismatch("The assigned branch has an unowned pull request");
    observed = existing ?? observed;
    if (observed) await saveObservation(observation("ambiguous"));
    if (existing) verifyPull(existing, pins, claim.headSha, runId);
    await verifySource(api, pins, pins.origin, phaseMismatch);
    await verifyCommit(api, pins, claim.headSha, runId, proof);
    if (!existing) throw unconfirmed("Draft publication is unconfirmed; reconciling the run branch");
    const candidate = verifyPull(existing, pins, claim.headSha, runId);
    const [accepted] = await db().update(forgejoIssueReviews).set({ candidate, draftObservation: null, effectDispatch: null })
      .where(draftPending).returning({ runId: forgejoIssueReviews.runId });
    if (accepted) return { candidate, summary: proof.summary };
    const latest = await savedReview(db, runId);
    if (latest?.candidate) return { candidate: await currentCandidate(api, latest, pins), summary: proof.summary };
    if (latest?.draftObservation?.status === "blocked") throw phaseMismatch(String(latest.draftObservation.reason));
    throw unconfirmed("The draft observation changed during reconciliation");
  } catch (error) {
    if (error instanceof PhaseMismatch)
      await saveObservation(observation("blocked", (await error.clone().text()).slice(0, 512)));
    retryUnknownDraftRead(error);
  }
}

async function reconcileReview(api: ReviewRepository, candidate: Candidate, pins: Target, claim: NonNullable<Row["reviewPublication"]>) {
  const items = z.array(z.object({
    id: number, html_url: z.url(), body: z.string().nullable(), commit_id: z.string(), state: z.string(),
    user: actor, dismissed: z.boolean().optional(), stale: z.boolean().optional(),
  })).parse(await api.get(`/pulls/${candidate.number}/reviews?${api.github ? "per_page=50" : "limit=50"}`));
  if (items.length >= 50) throw phaseMismatch("Review history exceeds the reconciliation limit");
  const owned = items.filter(item => item.user.id === pins.reviewerId && item.body?.includes(reviewMarker(claim.attemptId)));
  const current = owned[0];
  const expected = claim.verdict === "approved" ? "APPROVED" : api.github ? "CHANGES_REQUESTED" : "REQUEST_CHANGES";
  if (!current) throw unconfirmed("Formal review is unconfirmed at the pinned head");
  if (owned.length !== 1 || current.commit_id !== candidate.headSha || current.state !== expected ||
      current.dismissed || current.stale || new URL(current.html_url).origin !== pins.origin)
    throw phaseMismatch("Formal review differs from its pinned identity or head");
  return reviewReceipt.parse({ id: current.id, url: current.html_url, headSha: current.commit_id,
    verdict: claim.verdict, reviewer: current.user });
}

async function publishReview(host: WorkflowHost<"finalize">, db: IntakeContext["db"],
  { row, pins, api }: Awaited<ReturnType<typeof phaseSource>>, phase: z.infer<typeof finalizeInput>) {
  const candidate = await currentCandidate(api, row, pins);
  const ready = readyEffect(row.effectDispatch, "review");
  const result = phase.coordinator || ready ? null : reviewed.parse(phase.outputs.result);
  if (result && result.headSha !== candidate.headSha) throw phaseMismatch("Review reported a different commit");
  await verifyReviewer(host, pins, candidate);
  let claim = row.reviewPublication;
  if (claim && ready) {
    await verifySource(api, pins, pins.origin, phaseMismatch);
    const next = { attemptId: phase.node.attemptId, verdict: claim.verdict };
    const effect = await retryEffect(db, row.runId, ready, { reviewPublication: next });
    if (effect) {
      claim = next;
      await sendReview(host, db, row.runId, effect);
    } else {
      claim = (await savedReview(db, row.runId))?.reviewPublication ?? null;
    }
  } else if (!claim && result) {
    await verifySource(api, pins, pins.origin, phaseMismatch);
    claim = { attemptId: phase.node.attemptId, verdict: result.verdict };
    const effect = newEffect("review", {
      operation: "publish-review", reviewer: pins.reviewer, expectedReviewerId: pins.reviewerId,
      candidate: { number: candidate.number, headSha: candidate.headSha },
      verdict: result.verdict, summary: result.summary.replaceAll("<!--", "&lt;!--"),
    });
    const [claimed] = await db().update(forgejoIssueReviews).set({ reviewPublication: claim, effectDispatch: effect })
      .where(and(eq(forgejoIssueReviews.runId, row.runId), isNull(forgejoIssueReviews.reviewPublication))).returning();
    if (claimed) {
      await sendReview(host, db, row.runId, effect);
    } else {
      claim = (await savedReview(db, row.runId))?.reviewPublication ?? null;
    }
  }
  if (!claim || (result && result.verdict !== claim.verdict)) throw phaseMismatch("The formal review claim changed");
  const review = await reconcileReview(api, candidate, pins, claim);
  await currentCandidate(api, row, pins);
  await verifySource(api, pins, pins.origin, phaseMismatch);
  await db().update(forgejoIssueReviews).set({ review, effectDispatch: null })
    .where(and(eq(forgejoIssueReviews.runId, row.runId), isNull(forgejoIssueReviews.review)));
  return review;
}

async function sendReview(host: WorkflowHost<"finalize">, db: IntakeContext["db"], runId: string,
  effect: ReviewEffect<"review">) {
  const { payload } = effect;
  const published = await dispatchEffect(db, runId, effect, () => host.call("workspace.control", payload));
  if (published === undefined) return;
  const receipt = reviewReceipt.parse(published);
  if (receipt.reviewer.id !== payload.expectedReviewerId || receipt.headSha !== payload.candidate.headSha ||
      receipt.verdict !== payload.verdict)
    throw phaseMismatch("Unexpected broker review receipt");
}

export async function finalizeIssueReview(host: WorkflowHost<"finalize">, db: IntakeContext["db"],
  phase: z.infer<typeof finalizeInput>): Promise<PhaseInput> {
  const source = await phaseSource(host, db, phase);
  if (phase.node.nodeId === "implement") {
    const { candidate, summary } = await publishCandidate(db, source, phase);
    return { outputs: { result: { candidate, headSha: candidate.headSha,
      summary: summary ?? "Reconciled the pinned draft pull request." } } };
  }
  const review = await publishReview(host, db, source, phase);
  return { outputs: { result: { review, headSha: review.headSha, verdict: review.verdict,
    summary: phase.coordinator ? "Reconciled the formal review." : reviewed.parse(phase.outputs.result).summary } } };
}

const model = z.string().trim().min(1).max(128);
export const configureIssueReviewInput = z.strictObject({
  operation: z.literal("configure-issue-review"),
  provider: reviewProvider.optional(),
  repository,
  repositoryId: number,
  reviewer: z.string().min(1).max(128),
  implementerModel: model,
  reviewerModel: model,
});

export async function configureIssueReview(host: WorkflowHost<"operator">, db: IntakeContext["db"], input: z.infer<typeof configureIssueReviewInput>) {
  const provider = input.provider ?? "FORGEJO";
  const snapshot = await host.call("snapshot", {});
  const connectionId = reviewConnection(snapshot, input.repository, provider);
  const repoMetadata = await repositoryMetadata(host, input, connectionId);
  if (provider === "GITHUB" && repoMetadata.origin !== "https://github.com") throw denied("Pinned GitHub origin unavailable");
  const key = await pairKey(snapshot.installation.id, repoMetadata.origin, repoMetadata.id, provider);
  const prior = await selectedPair(db, key);

  const approve = async (role: Role, chosenModel: string) => {
    const forge = provider === "GITHUB" ? "GitHub" : "Forgejo";
    const prompt = `You are the ${role} for a pinned ${forge} issue review. Read the assigned local checkout, check actual results and report evidence.`;
    return host.call("binding.approve", {
      workflowId: issueReviewWorkflow,
      actor: role,
      label: role === "reviewer" ? input.reviewer : `${forge} issue review implementer`,
      workspace: {
        repository: repoMetadata.name,
        resource: String(repoMetadata.id),
        checkout: provider === "GITHUB" ? "github-pinned" : "forgejo-pinned",
        ...(provider === "FORGEJO" ? { connectionId } : {}),
        inferenceProvider: "spark",
        agentPermissions: { contents: "read", pull_requests: "read", issues: "read" },
        coordinatorPermissions: role === "implementer"
          ? { contents: "write", pull_requests: "write", issues: "read" }
          : { contents: "read", pull_requests: "read", issues: "read" },
        control: role === "reviewer" ? [
          { operation: "inspect-reviewer", phases: ["operator", "interactive", "prepare", "finalize"] },
          { operation: "publish-review", phases: ["finalize"] },
        ] : [],
        settings: { policy: issueReviewWorkflow, role, ...(role === "reviewer" ? { reviewer: input.reviewer } : {}) },
      },
      context: { model: chosenModel, profile: { id: `foundry-${provider.toLowerCase()}-${role}`,
        digest: await sha256Hex(prompt), systemPrompt: prompt }, capabilities: [] },
    });
  };
  const implementer = await approve("implementer", input.implementerModel);
  const reviewer = await approve("reviewer", input.reviewerModel);
  const currentSnapshot = await host.call("snapshot", {});
  if (currentSnapshot.installation.id !== snapshot.installation.id ||
      reviewConnection(currentSnapshot, input.repository, provider) !== connectionId ||
      (await repositoryMetadata(host, input, connectionId)).origin !== repoMetadata.origin)
    throw denied("The repository scope changed during configuration");
  const selection = { implementer: implementer.id, reviewer: reviewer.id, reviewerName: input.reviewer };
  const { worker, reviewerId } = await verifyPair(host, currentSnapshot, { ...input, provider }, connectionId, selection);
  const pair = { ...selection, reviewerId, workerId: worker.appId, connectionId };
  const same = (existing: Pair | undefined) => existing && Object.entries(pair).every(
    ([field, value]) => existing[field as keyof Pair] === value);
  if (!same(prior)) {
    const revision = crypto.randomUUID();
    const [saved] = prior
      ? await db().update(forgejoIssueReviewBindings).set({ ...pair, revision })
        .where(and(eq(forgejoIssueReviewBindings.key, key), eq(forgejoIssueReviewBindings.revision, prior.revision))).returning()
      : await db().insert(forgejoIssueReviewBindings).values({ ...pair, key, revision }).onConflictDoNothing().returning();
    if (!saved && !same(await selectedPair(db, key)))
      throw conflict("The actor pair changed during configuration");
  } else if (!same(await selectedPair(db, key))) {
    throw conflict("The actor pair changed during configuration");
  }
  return { workflow: issueReviewWorkflow, repository: repoMetadata.name, implementer: implementer.id, reviewer: reviewer.id };
}

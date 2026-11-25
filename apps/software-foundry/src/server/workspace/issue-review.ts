import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { requireAccess, requireOrganization, sha256Hex } from "@ai-outfitter/app-sdk/server";
import type { finalizeInput, OperationOutput, PhaseInput, prepareInput, prepareResult, WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { IntakeContext } from "../intake";
import { forgejoIssueReviews } from "../schema";
import { hostAPI } from "./forge";
import { phaseMismatch, verifyCommitTree, type CommitProof } from "./issue-review-commit";

export const issueReviewWorkflow = "foundry-forgejo-issue-review";
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const number = z.number().int().positive();
const repository = z.string().regex(/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const branch = z.string().min(1).max(180).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/)
  .refine(ref => !ref.includes("..") && !ref.startsWith("refs/") && ref !== "HEAD" &&
    ref.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".lock") && !part.endsWith(".")));
export const reviewForgejoIssueInput = z.strictObject({
  repository,
  repositoryId: number,
  issueNumber: number,
  baseRef: branch,
  baseSha: sha,
});
const target = reviewForgejoIssueInput.extend({
  origin: z.url(),
  branch,
  workerId: number,
  reviewer: z.string().min(1).max(128),
  reviewerId: number,
});
type Target = z.infer<typeof target>;
type Row = typeof forgejoIssueReviews.$inferSelect;
type Repository = OperationOutput<"repository.read">;
type Phase = "interactive" | "operator" | "prepare" | "finalize";
const conflict = (reason: string) => new Response(reason, { status: 409 });
const unconfirmed = (reason: string) => new Response(reason, { status: 503 });
const denied = (reason: string) => new Response(reason, { status: 403 });
const actor = z.object({ id: number, login: z.string().min(1) });
const metadata = z.object({ id: number, full_name: repository, html_url: z.url() });

function organizationConnection(snapshot: OperationOutput<"snapshot">, name: string) {
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
    throw conflict("The pinned Forgejo repository changed");
  return { name: repo.full_name, id: repo.id, origin: url.origin };
}

function sameRepository(repo: Repository, pins: Pick<Target, "repository" | "repositoryId">, connectionId: string) {
  return repo.forge === "forgejo" && repo.checkout === "forgejo-pinned" && repo.inferenceProvider === "spark" &&
    repo.connectionId === connectionId &&
    repo.repositoryId === pins.repositoryId &&
    repo.name.toLowerCase() === pins.repository.toLowerCase();
}

function reviewRepository(host: WorkflowHost<Phase>, repo: Repository, bindingId?: string) {
  const api = hostAPI(input => host.call("repository.request", { ...input, bindingId }));
  return {
    get: (suffix: string) => api(`${repo.path}${suffix}`),
    createPull: (body: Record<string, string>) => api(`${repo.path}/pulls`, body, "POST"),
    createBranch: (name: string, base: string) => api(`${repo.path}/branches`, { new_branch_name: name, old_ref_name: base }, "POST"),
    commitFiles: (body: { branch: string; message: string; files: ChangeFile[] }) =>
      api(`${repo.path}/contents`, body, "POST"),
  };
}
type ReviewRepository = ReturnType<typeof reviewRepository>;

async function verifySource(api: ReviewRepository, pins: z.infer<typeof reviewForgejoIssueInput>, origin?: string,
  mismatch = conflict) {
  const [repositoryResult, base, issueResult] = await Promise.all([
    api.get(""),
    api.get(`/branches/${pins.baseRef}`),
    api.get(`/issues/${pins.issueNumber}`),
  ]);
  const issue = z.object({ number, html_url: z.url(), title: z.string(), state: z.string(),
    body: z.string().nullish(), pull_request: z.unknown().optional() }).parse(issueResult);
  const repo = metadata.parse(repositoryResult);
  const provider = new URL(repo.html_url);
  if (!["https:", "http:"].includes(provider.protocol) || (origin && provider.origin !== origin) ||
      repo.id !== pins.repositoryId || repo.full_name.toLowerCase() !== pins.repository.toLowerCase() ||
      new URL(issue.html_url).origin !== provider.origin || issue.number !== pins.issueNumber ||
      issue.pull_request || issue.state !== "open")
    throw mismatch("The pinned Forgejo repository or open issue changed");
  const ref = z.object({ name: branch, commit: z.object({ id: sha }) }).parse(base);
  if (ref.name !== pins.baseRef || ref.commit.id !== pins.baseSha)
    throw mismatch("The pinned Forgejo base changed");
  return { origin: provider.origin, issue: { number: issue.number, title: issue.title, url: issue.html_url, body: (issue.body ?? "").slice(0, 16_000) } };
}

async function savedReview(db: IntakeContext["db"], runId: string) {
  return db().select().from(forgejoIssueReviews).where(eq(forgejoIssueReviews.runId, runId)).get();
}

async function bindingFor(host: WorkflowHost<"interactive">, snapshot: OperationOutput<"snapshot">,
  pins: z.infer<typeof reviewForgejoIssueInput>, connectionId: string, role: "implementer" | "reviewer") {
  const bindings = snapshot.bindings.filter(binding => binding.workflowId === issueReviewWorkflow &&
    binding.actor === role && binding.enabled && binding.kind === "external");
  const candidates = await Promise.allSettled(bindings.map(async binding => ({
    binding,
    repo: await host.call("repository.read", { bindingId: binding.id }),
  })));
  const matching = candidates.flatMap(candidate =>
    candidate.status === "fulfilled" && sameRepository(candidate.value.repo, pins, connectionId) ? [candidate.value] : []);
  if (matching.length !== 1) throw denied(`Exactly one approved Forgejo ${role} binding is required for this repository`);
  return matching[0];
}

async function stableRunId(installationId: string, origin: string, repositoryId: number, issueNumber: number) {
  const hash = await sha256Hex(JSON.stringify([issueReviewWorkflow, installationId, origin, repositoryId, issueNumber]));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function startReceipt(row: Row, status: string, existing: boolean) {
  const pins = target.parse(row.inputs["implement.inputs.target"]);
  return {
    run: { id: row.runId, workflow: issueReviewWorkflow, status, existing },
    target: reviewForgejoIssueInput.parse(Object.fromEntries(
      Object.keys(reviewForgejoIssueInput.shape).map(key => [key, pins[key as keyof Target]]))),
    candidate: row.candidate,
    review: row.review,
  };
}

export async function reviewForgejoIssue(context: IntakeContext, input: z.infer<typeof reviewForgejoIssueInput>) {
  const identity = requireOrganization(context.identity);
  requireAccess(identity, "write");
  if (identity.role === "external" || identity.callerOrganizationId) throw denied("Current organization access required");
  const host = context.host();
  const snapshot = await host.call("snapshot", {});
  if (snapshot.installation.id !== identity.installationId || !snapshot.installation.workflows.includes(issueReviewWorkflow))
    throw denied("Forgejo issue review workflow is unavailable");
  const connectionId = organizationConnection(snapshot, input.repository);
  const metadata = await repositoryMetadata(host, input, connectionId);

  const id = await stableRunId(identity.installationId, metadata.origin, input.repositoryId, input.issueNumber);
  const receipt = async (row: Row) => {
    const old = target.parse(row.inputs["implement.inputs.target"]);
    if (old.repository.toLowerCase() !== input.repository.toLowerCase() ||
        old.baseRef !== input.baseRef || old.baseSha !== input.baseSha)
      throw conflict("An existing review run has different immutable pins");
    if (row.inputs["implement.inputs.connectionId"] !== connectionId)
      throw denied("The pinned Forgejo connection changed");
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
      throw denied("The pinned Forgejo execution authority changed");
    await verifySource(reviewRepository(host, repo, bindingId), old, old.origin);
    const started = await host.call("workflow.start", { workflow: issueReviewWorkflow, id, inputs: jsonInputs(row.inputs) });
    return startReceipt(row, "running", !started.created);
  };
  const saved = await savedReview(context.db, id);
  if (saved) return receipt(saved);

  const [worker, reviewer] = await Promise.all([
    bindingFor(host, snapshot, input, connectionId, "implementer"),
    bindingFor(host, snapshot, input, connectionId, "reviewer"),
  ]);
  const pins = { ...input, repository: worker.repo.name };
  const { origin, issue } = await verifySource(reviewRepository(host, worker.repo, worker.binding.id), pins, metadata.origin);
  const reviewerName = reviewer.binding.label;
  const principal = actor.parse(await host.call("workspace.control", {
    operation: "inspect-reviewer", bindingId: reviewer.binding.id, reviewer: reviewerName,
  }));
  if (reviewer.repo.appId !== worker.repo.appId || principal.id === worker.repo.appId) throw denied("Forgejo worker and reviewer must be independent");
  const inputs = {
    "implement.inputs.target": { ...pins, origin, branch: `outfitter-review-${id}`,
      workerId: worker.repo.appId, reviewer: reviewerName, reviewerId: principal.id },
    "implement.inputs.issue": issue,
    "implement.inputs.connectionId": connectionId,
    "implement.inputs.implementerBinding": worker.binding.id,
    "implement.inputs.reviewerBinding": reviewer.binding.id,
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

const head = z.object({ ref: branch, sha, repo: z.object({ id: number, full_name: repository }) });
const pull = z.object({
  number,
  html_url: z.url(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  merged: z.boolean(),
  user: z.object({ id: number }),
  base: head,
  head,
});
const sourcePath = z.string().max(500).regex(/^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/)
  .refine(path => !path.includes("..") && !path.split("/").some(part => part === "." || part.toLowerCase() === ".git"));
const changes = z.strictObject({
  summary: z.string().trim().min(1).max(16_000),
  files: z.array(z.strictObject({ path: sourcePath, content: z.string().max(100_000).nullable() })).min(1).max(20),
}).refine(({ files }) => new Set(files.map(file => file.path)).size === files.length &&
  files.reduce((total, file) => total + new TextEncoder().encode(file.content ?? "").length, 0) <= 100_000);
type Changes = z.infer<typeof changes>;
type ChangeFile = { path: string; operation: "create" | "update" | "delete"; content?: string; sha?: string };

const implemented = z.object({ headSha: sha, summary: z.string().trim().min(1).max(16_000) });
const reviewed = implemented.extend({ verdict: z.enum(["approved", "changes-requested"]) });
const candidateReceipt = z.object({ number, url: z.url(), headSha: sha, branch, authorId: number });
const reviewReceipt = z.object({ id: number, url: z.url(), headSha: sha, verdict: reviewed.shape.verdict, reviewer: actor });
type Candidate = z.infer<typeof candidateReceipt>;
const marker = (runId: string) => `<!-- outfitter:issue-review:${runId} -->`;
const reviewMarker = (attemptId: string) => `<!-- outfitter:workspace-review:${attemptId} -->`;

function verifyPull(current: z.infer<typeof pull>, pins: Target, headSha: string, runId: string): Candidate {
  const same = (ref: z.infer<typeof head>) => ref.repo.id === pins.repositoryId &&
    ref.repo.full_name.toLowerCase() === pins.repository.toLowerCase();
  if (current.state !== "open" || current.merged || !/^WIP: /i.test(current.title) ||
      !same(current.base) || !same(current.head) || current.base.ref !== pins.baseRef ||
      current.base.sha !== pins.baseSha || current.head.ref !== pins.branch || current.head.sha !== headSha ||
      !current.body?.includes(marker(runId)) || current.user.id !== pins.workerId ||
      new URL(current.html_url).origin !== pins.origin)
    throw phaseMismatch("The draft pull request no longer matches its pinned repository, base, head or author");
  return { number: current.number, url: current.html_url, headSha, branch: pins.branch, authorId: current.user.id };
}

async function findPull(api: ReviewRepository, pins: Target) {
  let found: z.infer<typeof pull> | undefined;
  for (let page = 1; page <= 20; page++) {
    const items = z.array(z.unknown()).parse(await api.get(`/pulls?state=all&limit=50&page=${page}`));
    for (const item of items) {
      const match = z.object({ head: z.object({ ref: z.string(), repo: z.object({ id: number }).nullable() }) }).safeParse(item);
      if (match.success && match.data.head.ref === pins.branch && match.data.head.repo?.id === pins.repositoryId) {
        if (found) throw phaseMismatch("The review branch has multiple pull requests");
        found = pull.parse(item);
      }
    }
    if (items.length < 50) return found;
  }
  throw phaseMismatch("Pull request history exceeds the reconciliation limit");
}

async function optionalRead(api: ReviewRepository, suffix: string) {
  try {
    return await api.get(suffix);
  } catch (error) {
    if (error instanceof Response && error.status === 404) return null;
    throw error;
  }
}

const commitMessage = (runId: string, proof: CommitProof) => `Implement Forgejo issue review ${runId} ${proof.nonce}`;
const gitCommit = z.object({
  sha,
  commit: z.object({ message: z.string(), tree: z.object({ sha }) }),
  parents: z.array(z.object({ sha })),
  author: z.object({ id: number }).nullish(),
  committer: z.object({ id: number }).nullish(),
});
const commitPath = (revision: string) => `/git/commits/${revision}?stat=false&files=false`;

async function reviewBranchTip(api: ReviewRepository, pins: Target) {
  const tip = await optionalRead(api, `/branches/${pins.branch}`);
  if (!tip) return null;
  const current = z.object({ name: branch, commit: z.object({ id: sha }) }).parse(tip);
  if (current.name !== pins.branch) throw phaseMismatch("The assigned branch identity changed");
  return current.commit.id;
}

function requireCommitProof(row: Row) {
  if (!row.commitProof) throw phaseMismatch("The Forgejo commit has no durable file proof");
  return row.commitProof;
}

async function stagedCommit(api: ReviewRepository, pins: Target, row: Row) {
  const proof = requireCommitProof(row);
  const headSha = await reviewBranchTip(api, pins);
  const expectedHead = row.publication?.headSha ?? proof.headSha;
  if (expectedHead && expectedHead !== headSha) throw phaseMismatch("The pinned implementation commit changed");
  if (!headSha || headSha === pins.baseSha) throw unconfirmed("Commit publication is unconfirmed; reconciling the run branch");
  const headTree = await verifyCommit(api, pins, headSha, row.runId, proof);
  const base = gitCommit.parse(await api.get(commitPath(pins.baseSha)));
  if (base.sha !== pins.baseSha) throw phaseMismatch("The pinned Forgejo commit identity changed");
  await verifyCommitTree(api.get, base.commit.tree.sha, headTree, proof);
  return { headSha, proof };
}

async function verifyCommit(api: ReviewRepository, pins: Target, headSha: string, runId: string, proof: CommitProof) {
  const [tip, commit] = await Promise.all([reviewBranchTip(api, pins), api.get(commitPath(headSha))]);
  const object = gitCommit.parse(commit);
  if (tip !== headSha || object.sha !== headSha ||
      object.commit.message.trim() !== commitMessage(runId, proof) || object.parents.length !== 1 ||
      object.parents[0].sha !== pins.baseSha)
    throw phaseMismatch("The review branch must contain the verified commit directly on the pinned base");
  if (object.author?.id !== pins.workerId || object.committer?.id !== pins.workerId)
    throw phaseMismatch("Forgejo did not attribute the commit to the pinned writer");
  return object.commit.tree.sha;
}

type Node = z.infer<typeof prepareInput> | z.infer<typeof finalizeInput>;
async function phaseSource(host: WorkflowHost<"prepare" | "finalize">, db: IntakeContext["db"], phase: Node) {
  const { node, inputs } = phase;
  if (!["implement", "review"].includes(node.nodeId) || phase.settings.policy !== issueReviewWorkflow)
    throw denied("An admitted review run is required");
  const row = await savedReview(db, node.runId);
  if (!row) throw denied("An admitted review run is required");
  const run = await host.call("workflow.read", { id: node.runId });
  if (run?.run.workflowId !== issueReviewWorkflow || canonicalActionValue(run.inputs) !== canonicalActionValue(row.inputs))
    throw phaseMismatch("The admitted Forgejo run identity changed");
  const pins = target.parse(row.inputs["implement.inputs.target"]);
  const supplied = target.parse(inputs.target);
  if (JSON.stringify(supplied) !== JSON.stringify(pins)) throw phaseMismatch("Workflow target pins changed");
  const role = node.nodeId === "implement" ? "implementer" : "reviewer";
  if (phase.settings.role !== role || (role === "reviewer" && phase.settings.reviewer !== pins.reviewer))
    throw phaseMismatch("The approved Forgejo execution role changed");
  const bindingId = z.string().min(1).parse(row.inputs[`implement.inputs.${role}Binding`]);
  const repo = await host.call("repository.read", { bindingId });
  const connectionId = z.string().min(1).parse(row.inputs["implement.inputs.connectionId"]);
  if (!sameRepository(repo, pins, connectionId) || repo.appId !== pins.workerId)
    throw phaseMismatch("The pinned Forgejo execution authority changed");
  const api = reviewRepository(host, repo);
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
  if (current.number !== saved.number) throw phaseMismatch("The pinned pull request changed");
  return current;
}

export async function prepareIssueReview(host: WorkflowHost<"prepare">, db: IntakeContext["db"],
  phase: z.infer<typeof prepareInput>): Promise<z.input<typeof prepareResult>> {
  const { row, pins, api } = await phaseSource(host, db, phase);
  if (phase.node.nodeId === "implement") {
    if (row.commitClaim) return { mode: "coordinator" };
    return {
      mode: "agent", role: "implement", checkout: { sha: pins.baseSha },
      guidance: [
        `Work in the local repo checkout from ${pins.baseRef} at ${pins.baseSha}. Check that exact revision before editing.`,
        "Return changed text files with their complete contents, or null to delete a file, plus actual check outcomes. Foundry publishes the branch and opens the draft.",
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

async function fileOperation(api: ReviewRepository, pins: Target, file: Changes["files"][number]): Promise<ChangeFile> {
  const { path, content } = file;
  const previous = await optionalRead(api, `/contents/${path}?ref=${pins.baseSha}`);
  const existing = previous === null ? null : z.object({ type: z.literal("file"), sha }).parse(previous);
  if (content === null) {
    if (!existing) throw phaseMismatch("Cannot remove a file missing from the pinned base");
    return { operation: "delete", path, sha: existing.sha };
  }
  const encoded = btoa(Array.from(new TextEncoder().encode(content), byte => String.fromCharCode(byte)).join(""));
  return existing
    ? { operation: "update", path, sha: existing.sha, content: encoded }
    : { operation: "create", path, content: encoded };
}

async function publishBranch(db: IntakeContext["db"], { row, pins, api }: Awaited<ReturnType<typeof phaseSource>>,
  phase: z.infer<typeof finalizeInput>) {
  const { runId, attemptId } = phase.node;
  if (row.commitClaim) return stagedCommit(api, pins, row);
  if (phase.coordinator) throw phaseMismatch("An implementation result is required");
  const result = changes.parse(phase.outputs.result);
  const files: ChangeFile[] = [];
  for (const file of result.files) files.push(await fileOperation(api, pins, file));
  if (!row.branchClaim) {
    if (await reviewBranchTip(api, pins)) throw phaseMismatch("The assigned branch already exists");
    await verifySource(api, pins, pins.origin, phaseMismatch);
    const [claimed] = await db().update(forgejoIssueReviews).set({ branchClaim: attemptId })
      .where(and(eq(forgejoIssueReviews.runId, runId), isNull(forgejoIssueReviews.branchClaim))).returning();
    if (claimed) {
      try {
        await api.createBranch(pins.branch, pins.baseSha);
      } catch {
        // The write may have succeeded. Only the assigned branch can reconcile it.
      }
    }
  }
  const tip = await reviewBranchTip(api, pins);
  if (tip !== pins.baseSha) {
    const latest = await savedReview(db, runId);
    if (latest?.commitClaim) return stagedCommit(api, pins, latest);
    if (tip) throw phaseMismatch("The assigned branch does not point at the pinned base");
    throw unconfirmed("Branch creation is unconfirmed at the pinned base");
  }
  await verifySource(api, pins, pins.origin, phaseMismatch);
  const proof: CommitProof = {
    nonce: crypto.randomUUID(),
    files: await Promise.all(files.map(async file => ({
      path: file.path, beforeSha: file.sha ?? null,
      contentHash: file.content === undefined ? null : await sha256Hex(file.content),
    }))),
  };
  const [claimed] = await db().update(forgejoIssueReviews).set({ commitClaim: attemptId, commitProof: proof })
    .where(and(eq(forgejoIssueReviews.runId, runId), isNull(forgejoIssueReviews.commitClaim))).returning();
  if (claimed) {
    if (await reviewBranchTip(api, pins) !== pins.baseSha) throw phaseMismatch("The assigned branch moved before committing");
    await verifySource(api, pins, pins.origin, phaseMismatch);
    let written: unknown;
    try {
      written = await api.commitFiles({ branch: pins.branch, message: commitMessage(runId, proof), files });
    } catch {
      // A partially observed write is reconciled without issuing a second write.
    }
    const receipt = z.object({ commit: z.object({ sha }) }).safeParse(written);
    if (receipt.success) {
      proof.headSha = receipt.data.commit.sha;
      await db().update(forgejoIssueReviews).set({ commitProof: proof })
        .where(and(eq(forgejoIssueReviews.runId, runId), eq(forgejoIssueReviews.commitClaim, attemptId)));
      claimed.commitProof = proof;
    }
  }
  const current = claimed ?? await savedReview(db, runId);
  if (!current) throw phaseMismatch("The durable Forgejo commit claim changed");
  return stagedCommit(api, pins, current);
}

async function publishCandidate(db: IntakeContext["db"], source: Awaited<ReturnType<typeof phaseSource>>,
  phase: z.infer<typeof finalizeInput>) {
  const { row, pins, api } = source;
  const { attemptId, runId } = phase.node;
  if (row.candidate) return currentCandidate(api, row, pins);
  const { headSha, proof } = await publishBranch(db, source, phase);
  if (row.publication && row.publication.headSha !== headSha) throw phaseMismatch("The implementation commit changed");
  let existing = await findPull(api, pins);
  if (existing && !row.publication) {
    const latest = await savedReview(db, runId);
    if (latest?.publication?.headSha !== headSha) throw phaseMismatch("The assigned branch already has a pull request");
  }
  if (!existing && !row.publication) {
    const [claimed] = await db().update(forgejoIssueReviews).set({ publication: { attemptId, headSha } })
      .where(and(eq(forgejoIssueReviews.runId, runId), isNull(forgejoIssueReviews.publication))).returning();
    if (claimed) {
      await verifyCommit(api, pins, headSha, runId, proof);
      await verifySource(api, pins, pins.origin, phaseMismatch);
      let created: unknown;
      try {
        created = await api.createPull({
          head: pins.branch,
          base: pins.baseRef,
          title: `WIP: Review for issue #${pins.issueNumber}`,
          body: `Review of issue #${pins.issueNumber}.\n\n${marker(runId)}`,
        });
      } catch {
        // A lost response can still have created the draft. Reconcile by readback.
      }
      if (created !== undefined) verifyPull(pull.parse(created), pins, headSha, runId);
    }
    existing = await findPull(api, pins);
  }
  if (!existing) throw unconfirmed("Draft publication is unconfirmed; reconciling the run branch");
  const candidate = verifyPull(existing, pins, headSha, runId);
  await verifyCommit(api, pins, headSha, runId, proof);
  await verifySource(api, pins, pins.origin, phaseMismatch);
  await db().update(forgejoIssueReviews).set({ candidate })
    .where(and(eq(forgejoIssueReviews.runId, runId), isNull(forgejoIssueReviews.candidate)));
  return candidate;
}

async function reconcileReview(api: ReviewRepository, candidate: Candidate, pins: Target, claim: NonNullable<Row["reviewPublication"]>) {
  const items = z.array(z.object({
    id: number, html_url: z.url(), body: z.string().nullable(), commit_id: z.string(), state: z.string(),
    user: actor, dismissed: z.boolean().optional(), stale: z.boolean().optional(),
  })).parse(await api.get(`/pulls/${candidate.number}/reviews?limit=50`));
  if (items.length >= 50) throw phaseMismatch("Review history exceeds the reconciliation limit");
  const owned = items.filter(item => item.body?.includes(reviewMarker(claim.attemptId)));
  const current = owned[0];
  const expected = claim.verdict === "approved" ? "APPROVED" : "REQUEST_CHANGES";
  if (!current) throw unconfirmed("Formal review is unconfirmed at the pinned head");
  if (owned.length !== 1 || current.user.id !== pins.reviewerId || current.commit_id !== candidate.headSha || current.state !== expected ||
      current.dismissed || current.stale || new URL(current.html_url).origin !== pins.origin)
    throw phaseMismatch("Formal review differs from its pinned identity or head");
  return reviewReceipt.parse({ id: current.id, url: current.html_url, headSha: current.commit_id,
    verdict: claim.verdict, reviewer: current.user });
}

async function publishReview(host: WorkflowHost<"finalize">, db: IntakeContext["db"],
  { row, pins, api }: Awaited<ReturnType<typeof phaseSource>>, phase: z.infer<typeof finalizeInput>) {
  const candidate = await currentCandidate(api, row, pins);
  const result = phase.coordinator ? null : reviewed.parse(phase.outputs.result);
  if (result && result.headSha !== candidate.headSha) throw phaseMismatch("Review reported a different commit");
  await verifyReviewer(host, pins, candidate);
  let claim = row.reviewPublication;
  if (!claim && result) {
    claim = { attemptId: phase.node.attemptId, verdict: result.verdict };
    const [claimed] = await db().update(forgejoIssueReviews).set({ reviewPublication: claim })
      .where(and(eq(forgejoIssueReviews.runId, row.runId), isNull(forgejoIssueReviews.reviewPublication))).returning();
    if (claimed) {
      await currentCandidate(api, row, pins);
      await verifySource(api, pins, pins.origin, phaseMismatch);
      let published: unknown;
      try {
        published = await host.call("workspace.control", {
          operation: "publish-review", reviewer: pins.reviewer, expectedReviewerId: pins.reviewerId,
          candidate: { number: candidate.number, headSha: candidate.headSha },
          verdict: result.verdict, summary: result.summary.replaceAll("<!--", "&lt;!--"),
        });
      } catch {
        // Independently reconcile the pinned marker, including a lost response.
      }
      if (published !== undefined) {
        const receipt = reviewReceipt.parse(published);
        if (receipt.reviewer.id !== pins.reviewerId || receipt.headSha !== candidate.headSha || receipt.verdict !== result.verdict)
          throw phaseMismatch("Unexpected broker review receipt");
      }
    } else {
      claim = (await savedReview(db, row.runId))?.reviewPublication ?? null;
    }
  }
  if (!claim || (result && result.verdict !== claim.verdict)) throw phaseMismatch("The formal review claim changed");
  const review = await reconcileReview(api, candidate, pins, claim);
  await currentCandidate(api, row, pins);
  await verifySource(api, pins, pins.origin, phaseMismatch);
  await db().update(forgejoIssueReviews).set({ review })
    .where(and(eq(forgejoIssueReviews.runId, row.runId), isNull(forgejoIssueReviews.review)));
  return review;
}

export async function finalizeIssueReview(host: WorkflowHost<"finalize">, db: IntakeContext["db"],
  phase: z.infer<typeof finalizeInput>): Promise<PhaseInput> {
  const source = await phaseSource(host, db, phase);
  if (phase.node.nodeId === "implement") {
    const candidate = await publishCandidate(db, source, phase);
    return { outputs: { result: { candidate, headSha: candidate.headSha,
      summary: phase.coordinator ? "Reconciled the pinned draft pull request." : changes.parse(phase.outputs.result).summary } } };
  }
  const review = await publishReview(host, db, source, phase);
  return { outputs: { result: { review, headSha: review.headSha, verdict: review.verdict,
    summary: phase.coordinator ? "Reconciled the formal review." : reviewed.parse(phase.outputs.result).summary } } };
}

const model = z.string().trim().min(1).max(128);
export const configureIssueReviewInput = z.strictObject({
  operation: z.literal("configure-issue-review"),
  repository,
  repositoryId: number,
  reviewer: z.string().min(1).max(128),
  implementerModel: model,
  reviewerModel: model,
});

export async function configureIssueReview(host: WorkflowHost<"operator">, input: z.infer<typeof configureIssueReviewInput>) {
  const snapshot = await host.call("snapshot", {});
  const connectionId = organizationConnection(snapshot, input.repository);
  const repoMetadata = await repositoryMetadata(host, input, connectionId);

  const approve = async (role: "implementer" | "reviewer", chosenModel: string) => {
    const prompt = `You are the ${role} for a pinned Forgejo issue review. Read the assigned local checkout, check actual results and report evidence.`;
    return host.call("binding.approve", {
      workflowId: issueReviewWorkflow,
      actor: role,
      label: role === "reviewer" ? input.reviewer : "Forgejo issue review implementer",
      workspace: {
        repository: repoMetadata.name,
        resource: String(repoMetadata.id),
        checkout: "forgejo-pinned",
        connectionId,
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
      context: { model: chosenModel, profile: { id: `foundry-forgejo-${role}`,
        digest: await sha256Hex(prompt), systemPrompt: prompt }, capabilities: [] },
    });
  };
  const implementer = await approve("implementer", input.implementerModel);
  const reviewer = await approve("reviewer", input.reviewerModel);
  const repo = await host.call("repository.read", { bindingId: implementer.id });
  const independent = actor.parse(await host.call("workspace.control", {
    bindingId: reviewer.id, operation: "inspect-reviewer", reviewer: input.reviewer,
  }));
  if (!sameRepository(repo, input, connectionId) || repo.appId === independent.id)
    throw denied("Forgejo implementer and reviewer must be independently scoped");
  return { workflow: issueReviewWorkflow, repository: repoMetadata.name, implementer: implementer.id, reviewer: reviewer.id };
}

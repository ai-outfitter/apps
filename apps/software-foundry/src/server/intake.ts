// Software Foundry's work intake and readback: the actions Planning calls (actions.call)
// to hand Foundry a unit of software work and read it back. Foundry
// resolves the approved GitHub repository, creates or attaches the issue, and
// starts the canonical issue-to-merge workflow through the same launch path as
// a manual start. Triage, implementation, independent review, checks, evidence
// and merge stay with that workflow. See docs/foundry-intake.md.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { type ActionContext, defineAction } from "@ai-outfitter/app-sdk/actions";
import { entityRef } from "@ai-outfitter/app-sdk/entities";
import { sha256Hex, type AppActor } from "@ai-outfitter/app-sdk/server";
import type { StorageLocals } from "@ai-outfitter/app-sdk/storage";
import { publishedFoundryEvidence } from "./workspace/demo-handoff";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { type FoundryDatabase, repositoryName } from "./projects";
import { foundryProjects, workSubmissions } from "./schema";
import { existingFoundryIssueRun, foundryIssueRunId, issueRuns, resolveFoundryRepository, startExistingFoundryIssue, submissionRepository, type ResolvedFoundryRepository } from "./workspace/workspaces";

export type IntakeContext = ActionContext & { host: () => WorkflowHost<"interactive">; db: () => FoundryDatabase; storageLocals?: StorageLocals; origin: string };

const conflict = (message: string) => new Response(message, { status: 409 });
const target = z.strictObject({
  repository: repositoryName.optional(),
  /** A Foundry project that must include the repository. */
  project: z.string().min(1).max(128).optional(),
}).refine(value => value.repository || value.project, "Name a repository or Foundry project");
const submittedIssue = z.strictObject({ number: z.number().int().positive(), url: z.string(), created: z.boolean() });
/** The intake's limit for a rendered issue or comment body (the GitHub connector's body limit). */
export const bodyLimit = 60_000;

const sourceRef = entityRef.extend({ revision: z.number().int().positive() });
export const frozenWorkPackage = z.strictObject({
  version: z.literal(1),
  rendered: z.string().min(1).max(40_000),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  sources: z.array(sourceRef).min(1).max(256),
  criteria: z.array(sourceRef.extend({ condition: z.string().min(1).max(2000), expectedOutcome: z.string().min(1).max(2000) })).min(1).max(50),
  template: sourceRef.optional(),
});
export const submitInput = z.strictObject({
  target,
  workPackage: frozenWorkPackage.optional(),
  /** The caller's retry key (case-insensitive): the same ID finds the issue or comment an earlier attempt wrote. */
  requestId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(40_000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(50),
  /** Attach this existing open issue instead of creating one; the submission is recorded as a comment. */
  issue: z.number().int().positive().optional(),
  /** Context records (ontology, goals, stories, use cases) the work relies on. Rendered as references; not resolved. */
  context: z.array(entityRef.extend({ title: z.string().trim().max(200).optional() })).max(32).default([]),
});
export const submitOutput = z.strictObject({
  submissionId: z.string(),
  repository: z.string(),
  issue: submittedIssue,
  /** `status` is the run's recorded state; a new run is `running`. A finished run is not restarted. */
  run: z.strictObject({ id: z.string(), workflow: z.string(), existing: z.boolean(), status: z.string(), url: z.string() }).nullable(),
  /** The issue is recorded even when execution setup is absent or start failed.
   * An uncertain result must be reconciled before assuming no run started. */
  execution: z.strictObject({ status: z.enum(["blocked", "outcome-unknown"]), message: z.string() }).optional(),
});
const openIssue = z.object({ number: z.number(), html_url: z.string(), state: z.string(), pull_request: z.unknown().optional() });

/** A caller's self-described display label, shown literally as a code span. */
const displayLabel = (label: string) => `\`${label.replace(/[`<>]/g, " ").replace(/\s+/g, " ").trim()}\``;
const actorLabel = (actor: AppActor) => `${actor.kind} \`${actor.id}\`${actor.label ? ` (${displayLabel(actor.label)})` : ""}`;

const referenceLabel = (ref: z.output<typeof sourceRef>) => `\`${ref.type}:${ref.id}\` in installation \`${ref.installationId}\` at revision \`${ref.revision}\``;
export async function workPackageDigest(value: Omit<z.output<typeof frozenWorkPackage>, "digest"> & { digest?: string }) {
  const {digest: _digest, ...frozen} = value;
  return sha256Hex(new TextEncoder().encode(canonical(frozen)));
}

/** The issue body: the submitted work plus attribution from the verified caller only. */
export function intakeIssueBody(context: Pick<ActionContext, "identity" | "actor" | "originActor">, input: z.output<typeof submitInput>) {
  return [
    input.workPackage?.rendered ?? (input.description || "_No description._"),
    "",
    "## Acceptance criteria",
    ...(input.workPackage ? input.workPackage.criteria.map(criterion => `- [ ] ${criterion.condition} → ${criterion.expectedOutcome} (${referenceLabel(criterion)})`) : input.acceptanceCriteria.map((line) => `- [ ] ${line}`)),
    ...(input.workPackage ? ["", "## Frozen work package", `SHA-256: \`${input.workPackage.digest}\``, ...input.workPackage.sources.map(ref => `- ${referenceLabel(ref)}`), ...(input.workPackage.template ? [`Template: ${referenceLabel(input.workPackage.template)}`] : [])] : []),
    ...(input.context.length ? ["", "## Context", ...input.context.map((ref) =>
      `- ${ref.title ? `${ref.title} ` : ""}(\`${ref.type}:${ref.id}\` in installation \`${ref.installationId}\`)`)] : []),
    "",
    `Submitted to Software Foundry for user \`${context.identity.userId}\` by ${actorLabel(context.actor)}` +
      (JSON.stringify(context.originActor) === JSON.stringify(context.actor) ? "." : `, initiated by ${actorLabel(context.originActor)}.`),
  ].join("\n");
}

/** The comment recording a submission on an attached issue. */
export function intakeComment(context: Pick<ActionContext, "identity" | "actor" | "originActor">, input: z.output<typeof submitInput>) {
  return `## Submitted to Software Foundry: ${input.title}\n\n${intakeIssueBody(context, input)}`;
}

/** Resolve an authorized repository against an optional installation-owned project.
 * Admission uses current caller grants; execution subscriptions and bindings are
 * checked separately when work is explicitly launched. */
export async function approvedTarget(context: IntakeContext, value: z.output<typeof target>, requestHost?: WorkflowHost<"interactive">) {
  let repository = value.repository;
  let project: typeof foundryProjects.$inferSelect | null = null;
  if (value.project) {
    [project] = await context.db().select().from(foundryProjects).where(eq(foundryProjects.id, value.project));
    if (!project) throw conflict("Foundry project not found");
    if (!repository) {
      if (project.repositories.length !== 1) throw conflict("Foundry project must configure exactly one repository for project-only routing");
      repository = project.repositories[0];
    }
    if (!project.repositories.includes(repository.toLowerCase())) throw conflict("The repository is not part of the selected Foundry project");
  }
  if (!repository) throw conflict("Foundry target required");
  const host = requestHost ?? context.host();
  const snapshot = await host.call("snapshot", {});
  const repo = await submissionRepository(host, snapshot, repository);
  return { host, snapshot, repo, project };
}

/** Foundry's existing run page (the link its jobs list uses). */
const runURL = (context: IntakeContext, id: string, workflow: string) =>
  new URL(`/workflows?workflow=${encodeURIComponent(workflow)}&run=${encodeURIComponent(id)}`, context.origin).href;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function submissionKey(context: IntakeContext, requestId: string) {
  return sha256Hex(new TextEncoder().encode(canonical([context.identity.installationId, context.identity.organizationId ?? null, context.identity.userId, context.actor.kind, context.actor.id, requestId.toLowerCase()])));
}

/** Only pinned workflow receipts, not arbitrary URLs from user descriptions. */
export function outputChanges(outputs: Record<string, {value: unknown; complete: boolean}>) {
  const found = new Map<string, {number:number;headSha:string}>();
  const visit = (value: unknown, depth = 0) => {
    if (depth > 8 || !value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (Number.isSafeInteger(item.number) && Number(item.number) > 0 && typeof item.headSha === "string" && /^[a-f0-9]{40}$/.test(item.headSha)) found.set(`${item.number}:${item.headSha}`, {number: Number(item.number),headSha:item.headSha});
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  for (const output of Object.values(outputs)) if (output.complete) visit(output.value);
  return [...found.values()].slice(0, 50);
}

type Submission = typeof workSubmissions.$inferSelect;
async function reconcileSubmission(context: IntakeContext, host: WorkflowHost<"interactive">, input: z.output<typeof submitInput>, resolved: Pick<ResolvedFoundryRepository, "repo">, receipt: Submission, marker: string) {
  const {repo} = resolved;
  const connectionId = repo.connection.id;
  const key = receipt.key;
  // Reconcile only a positively observed marker. Absence from a bounded
  // provider listing is not proof that a timed-out creation did not occur.
  const tag = `<!-- outfitter-request:${marker} -->`;
  for (let page = 1; page <= 5 && !receipt.issue; page++) {
    const rows = await host.call("repository.request", { connectionId, path: input.issue ? `${repo.path}/issues/${input.issue}/comments?per_page=100&page=${page}` : `${repo.path}/issues?state=all&per_page=100&page=${page}` });
    if (!Array.isArray(rows)) break;
    const found = z.array(z.object({body:z.string().optional(),pull_request:z.unknown().optional()}).passthrough()).parse(rows).find((row) => typeof row.body === "string" && row.body.includes(tag) && !row.pull_request);
    if (found) {
      const recovered = input.issue ? openIssue.parse(await host.call("repository.request", { connectionId, path: `${repo.path}/issues/${input.issue}` })) : openIssue.parse(found);
      receipt.issue = {number: recovered.number, url: recovered.html_url, created: false};
      await context.db().update(workSubmissions).set({issue: receipt.issue}).where(eq(workSubmissions.key,key));
    }
    if (rows.length < 100) break;
  }
  if (!receipt.issue) throw conflict("Submission in progress or external write outcome uncertain; inspect provider marker before retrying. No duplicate write was attempted.");
}

async function validateAttachment(context: IntakeContext, input: z.output<typeof submitInput>, host: WorkflowHost<"interactive">, resolved: Pick<ResolvedFoundryRepository, "repo">) {
  if (!input.issue) return null;
  const key = await submissionKey(context,input.requestId);
  const [prior] = await context.db().select().from(workSubmissions).where(eq(workSubmissions.key,key));
  if (prior) return prior.issue;
  const existing = openIssue.parse(await host.call("repository.request", {connectionId:resolved.repo.connection.id,path:`${resolved.repo.path}/issues/${input.issue}`}));
  if (existing.pull_request || existing.state !== "open") throw conflict("Attach an open issue, not a pull request or closed issue");
  return {number:existing.number,url:existing.html_url,created:false};
}

async function claimSubmission(context: IntakeContext, input: z.output<typeof submitInput>, host: WorkflowHost<"interactive">, resolved: Pick<ResolvedFoundryRepository, "repo">) {
  const {repo} = resolved;
  const key = await submissionKey(context, input.requestId);
  const payload = { ...input, requestId: input.requestId.toLowerCase() };
  const payloadDigest = await sha256Hex(new TextEncoder().encode(canonical(payload)));
  const [claimed] = await context.db().insert(workSubmissions).values({ key, requestId: input.requestId.toLowerCase(), payloadDigest, payload, repository: repo.name, createdAt: Date.now() }).onConflictDoNothing().returning();
  const [receipt] = claimed ? [claimed] : await context.db().select().from(workSubmissions).where(eq(workSubmissions.key, key));
  if (receipt.payloadDigest !== payloadDigest || receipt.repository !== repo.name) throw conflict("Request ID already belongs to a different submission");
  const marker = `request:${input.workPackage ? key : input.requestId.toLowerCase()}`;
  if (!claimed && !receipt.issue) await reconcileSubmission(context, host, input, resolved, receipt, marker);
  // Even a 403 can be raised by the host's post-provider authority recheck.
  // Once issued, every uncertain connector call retains its durable claim.
  const execute = (value: Parameters<typeof host.call<"connector.execute">>[1]) => host.call("connector.execute",value);
  return {key,receipt,marker,execute};
}

const providerFailure = (error: unknown) => error instanceof Response ? `HTTP ${error.status}` : "invalid provider response";

const compactPull = z.object({
  base:z.object({repo:z.object({full_name:z.string().max(140)})}),head:z.object({sha:z.string().regex(/^[a-f0-9]{40}$/)}),
  html_url:z.string().max(2048),merge_commit_sha:z.string().regex(/^[a-f0-9]{40}$/).nullable().optional(),
  merged:z.boolean().optional(),state:z.string().max(64),
});
const compactReview = z.object({
  id:z.number().int(),state:z.string().max(64),commit_id:z.string().max(64).nullable(),
  user:z.object({login:z.string().max(256)}).nullish(),
  submitted_at:z.string().max(64).nullish(),html_url:z.string().max(2048).optional(),
});
const compactCheck = z.object({
  id:z.number().int().optional(),name:z.string().max(256).optional(),head_sha:z.string().max(64),
  status:z.string().max(64).optional(),conclusion:z.string().max(64).nullable(),html_url:z.string().max(2048).optional(),
});
const compactReceipt = z.object({deliveryId:z.string().max(256),provider:z.string().max(64),receivedAt:z.number(),status:z.string().max(64)});
const compactImage = z.object({
  id:z.string().max(512),runId:z.string().max(128),name:z.string().max(256),contentType:z.string().max(128),
  revision:z.string().max(128).nullable(),url:z.string().max(2048),createdAt:z.number().optional(),
  sha256:z.string().max(64).optional(),headSha:z.string().max(64).optional(),filename:z.string().max(256).optional(),
  width:z.number().optional(),height:z.number().optional(),expiresAt:z.number().nullable().optional(),
});

/** Leave room for action metadata under the platform's 512 KiB response cap. */
export function boundedWorkReadback<T>(result: T): T {
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 480 * 1024)
    throw new Response("Work evidence exceeds the bounded readback size; inspect the linked Foundry run and narrow the submitted work scope. No required evidence was silently omitted.",{status:413});
  return result;
}

async function pullRequestEvidence(host: WorkflowHost<"interactive">, resolved: Pick<ResolvedFoundryRepository, "repo">, receipt: Submission, candidates: ReturnType<typeof outputChanges>) {
  const grouped = Map.groupBy(candidates,candidate => candidate.number);
  const pullRequests = [];
  const blockers = [];
  const repositoryPath = `/repos/${receipt.repository.toLowerCase()}`;
  const read = (path:string) => host.call("repository.request",{connectionId:resolved.repo.connection.id,path});
  for (const [number, revisions] of grouped) {
    try {
      const path = `${repositoryPath}/pulls/${number}`;
      const pull = compactPull.parse(await read(path));
      if (pull.base?.repo?.full_name?.toLowerCase() !== receipt.repository.toLowerCase() || !revisions.some(revision => revision.headSha === pull.head?.sha)) {
        blockers.push(`PR ${number} no longer matches its recorded repository/commit`); continue;
      }
      const headSha = pull.head?.sha ?? "";
      const [owner, name] = receipt.repository.split("/");
      const linked = await host.call("repository.request", { connectionId: resolved.repo.connection.id, method: "POST", path: "/graphql", body: {
        query: "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100){nodes{number repository{nameWithOwner}}}}}}",
        variables: {owner,name,number:number},
      } }) as {data?:{repository?:{pullRequest?:{closingIssuesReferences?:{nodes?:{number:number;repository?:{nameWithOwner?:string}}[]}}}}};
      if (!linked.data?.repository?.pullRequest?.closingIssuesReferences?.nodes?.some((issue) => issue.number === receipt.issue?.number && issue.repository?.nameWithOwner?.toLowerCase() === receipt.repository.toLowerCase())) {
        blockers.push(`PR ${number} does not close the submitted issue`); continue;
      }
      const [reviews, checks] = await Promise.all([
        read(`${path}/reviews?per_page=100`),
        read(`${repositoryPath}/commits/${headSha}/check-runs?per_page=100`),
      ]);
      blockers.push(...evidencePageBlockers(reviews,checks,number));
      pullRequests.push({ number: number, url: pull.html_url, repository: receipt.repository, headSha: headSha, mergeSha: pull.merged ? pull.merge_commit_sha ?? null : null, merged: pull.merged === true, state: pull.state, reviews:z.array(compactReview).max(100).parse(reviews), checks:z.object({total_count:z.number().int().nonnegative().optional(),check_runs:z.array(compactCheck).max(100)}).parse(checks) });
    } catch (error) { blockers.push(`PR ${number} evidence unavailable (${providerFailure(error)})`); }
  }
  if (!pullRequests.length) blockers.push("No verified pinned pull request evidence available");
  return {pullRequests,blockers};
}
function evidencePageBlockers(reviews: unknown, checks: unknown, number: number) {
  const blockers: string[] = [];
  if (Array.isArray(reviews) && reviews.length >= 100) blockers.push(`PR ${number} review page may be incomplete`);
  const checkPage = checks as {total_count?:number;check_runs?:unknown[]};
  if (!Array.isArray(reviews) || !Array.isArray(checkPage.check_runs)) blockers.push(`PR ${number} review/check evidence unavailable`);
  if ((checkPage.total_count ?? 0) > (checkPage.check_runs?.length ?? 0) || (checkPage.check_runs?.length ?? 0) >= 100) blockers.push(`PR ${number} check page may be incomplete`);
  return blockers;
}

/** Generic artifact storage is optional in production. Missing image/receipt
 * services are evidence gaps, never a reason to discard otherwise verified PRs. */
async function runEvidence(host: WorkflowHost<"interactive">, runId: string) {
  const [receipts,images] = await Promise.allSettled([
    host.call("connector.receipts",{runId}).then(value=>z.array(compactReceipt).parse(value)), host.call("artifacts.published",{runId}).then(value=>z.array(compactImage).parse(value)),
  ]);
  return {
    receipts: receipts.status === "fulfilled" ? receipts.value : [],
    images: images.status === "fulfilled" ? images.value : [],
    gaps: [
      ...(receipts.status === "rejected" ? [`Run ${runId} connector receipts unavailable (${providerFailure(receipts.reason)})`] : []),
      ...(images.status === "rejected" ? [`Run ${runId} published images unavailable (${providerFailure(images.reason)})`] : []),
    ],
  };
}

/** Existing Foundry screenshot storage is authoritative for its run/commit.
 * Generic host artifact storage may be absent; optional service gaps remain
 * separate from hard PR verification blockers. */
async function nativeRunImages(context: IntakeContext, runs: {run:{id:string};outputs:Parameters<typeof outputChanges>[0]}[], pullRequests: {number:number;headSha:string}[]) {
  if (!context.storageLocals) return {images:[],gaps:[]};
  const images = [];
  const gaps = [];
  for (const run of runs) {
    const heads = new Set(outputChanges(run.outputs).filter(candidate=>pullRequests.some(pull=>pull.number === candidate.number && pull.headSha === candidate.headSha)).map(candidate=>candidate.headSha));
    for (const headSha of heads) {
      try {
        const receipts = await publishedFoundryEvidence(context.storageLocals,context.origin,run.run.id,headSha);
        images.push(...receipts.map(receipt=>({...receipt,id:`foundry:${receipt.runId}:${receipt.headSha}:${receipt.sha256}`,name:receipt.filename,contentType:"image/png",revision:receipt.headSha})));
      } catch (error) { gaps.push(`Run ${run.run.id} screenshot evidence unavailable (${providerFailure(error)})`); }
    }
  }
  return {images,gaps};
}

function boundedEvidence(receipts: z.output<typeof compactReceipt>[], images: unknown[], gaps: string[]) {
  const boundedImages = z.array(compactImage).parse(images);
  return {
    receipts:receipts.slice(0,200),images:boundedImages.slice(0,100),
    gaps:[...gaps,...(receipts.length>200 ? ["Additional connector receipt metadata omitted at the 200-record bound; inspect linked runs for any required missing receipt"] : []),...(boundedImages.length>100 ? ["Additional images omitted at the 100-record bound; inspect linked runs for any required missing image"] : [])],
  };
}

async function finishSubmission(context: IntakeContext, host: WorkflowHost<"interactive">, snapshot: Awaited<ReturnType<typeof approvedTarget>>["snapshot"], repo: Awaited<ReturnType<typeof submissionRepository>>, issue: z.infer<typeof submittedIssue>, key: string) {
      try {
        const resolved = await resolveFoundryRepository(host, snapshot, repo.name, repo);
        const run = resolved
          ? await startExistingFoundryIssue(host, repo.name, issue.number, undefined, { snapshot, resolved })
          : await existingFoundryIssueRun(host, snapshot.installation.id, String(repo.repositoryId), issue.number);
        if (!run) return { submissionId: key, repository: repo.name, issue, run: null,
          execution: { status: "blocked" as const, message: "Issue recorded. Foundry execution is not configured for the active package and repository; refresh the execution bindings to start it." } };
        // A replayed claim of the same run ID (created: false) is an existing run too.
        return { submissionId: key, repository: repo.name, issue, run: { id: run.id, workflow: run.workflow, existing: run.existing || !run.created, status: run.status, url: runURL(context, run.id, run.workflow) } };
      } catch (error) {
        if (!(error instanceof Response)) throw error;
        return { submissionId: key, repository: repo.name, issue, run: null,
          execution: { status: "outcome-unknown" as const, message: `Issue recorded, but workflow execution could not be confirmed (${error.status}): ${(await error.text()).slice(0, 1024)}. Inspect the issue's runs before assuming it did not start.` } };
      }
}

export const submitDescription = "Submit work to a GitHub repository accessible through your account or the organization's GitHub App. Records an issue (or a comment on an existing open issue), then starts the configured Foundry workflow. If execution is unavailable, returns the issue with run: null and execution details; the work is still recorded. An existing run is not restarted. Attribution comes from your authenticated connection. Retry only with the same requestId.";

const readinessBlocker = z.object({ code: z.enum(["repository", "connector", "executor"]), message: z.string(), remediation: z.string() });
export const foundryActions = {
  "work.readiness": defineAction({
    description: "Check, without submitting anything, whether Foundry could accept work for a repository now: the caller's repository authorization, the connector operations an intake needs, and an enabled execution workflow. Answers blockers with remediation.",
    access: "read", input: z.strictObject({ repository: repositoryName }),
    output: z.object({ repository: z.string(), ready: z.boolean(), repositoryId: z.number().nullable(), execution: z.boolean(), blockers: z.array(readinessBlocker) }),
    async run(context: IntakeContext, { repository }) {
      const host = context.host();
      const snapshot = await host.call("snapshot", {});
      const blockers: z.infer<typeof readinessBlocker>[] = [];
      let repo: Awaited<ReturnType<typeof submissionRepository>> | null = null;
      try { repo = await submissionRepository(host, snapshot, repository); }
      catch (error) {
        if (!(error instanceof Response)) throw error;
        blockers.push({ code: "repository", message: `No authorized access to ${repository} (${error.status}): ${(await error.text()).slice(0, 300)}`,
          remediation: `Authorize the repository: install the GitHub App on ${repository} or grant it to your GitHub connection, then check again.` });
      }
      if (repo && !repo.connection.operations.includes("issues.create"))
        blockers.push({ code: "connector", message: "The GitHub connection cannot create issues for this repository", remediation: "Reconnect GitHub with issue access for Software Foundry." });
      const execution = repo ? Boolean(await resolveFoundryRepository(host, snapshot, repo.name, repo).catch(() => null)) : false;
      if (repo && !execution)
        blockers.push({ code: "executor", message: "No enabled Foundry execution workflow is bound to this repository", remediation: "Configure the repository's Foundry workspaces (Software Foundry → repository → Configure) so submitted work can run." });
      return { repository: repo?.name ?? repository, ready: blockers.length === 0, repositoryId: repo?.repositoryId ?? null, execution, blockers };
    },
  }),
  "work.targets": defineAction({
    description: "List configured Foundry project destinations and whether project-only routing is unambiguous. Current repository grants and enabled execution workflow are checked before submission.",
    access: "read", input: z.strictObject({}),
    output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), ready: z.boolean(), blocker: z.string().nullable() })) }),
    async run(context: IntakeContext) {
      await context.host().call("snapshot", {});
      const projects = await context.db().select().from(foundryProjects);
      return {projects: projects.map(project => ({id:project.id,name:project.name,ready:project.repositories.length === 1,blocker:project.repositories.length === 1 ? null : "Configure exactly one repository for project-only routing"}))};
    },
  }),
  "work.get": defineAction({
    description: "Read a submitted work package, current execution and pinned PR evidence. Requires current authorized Foundry repository access; accepts a submission ID or an unambiguous request ID, never an arbitrary run ID.",
    access: "read",
    input: z.strictObject({ submissionId: z.string().regex(/^[a-f0-9]{64}$/).optional(), requestId: z.uuid().optional() }).refine(value => value.submissionId || value.requestId, "Name a submission or request ID"),
    output: z.object({ submissionId: z.string(), repository: z.string(), issue: submittedIssue.nullable(), workPackage: frozenWorkPackage.nullable(), run: z.unknown().nullable(), pullRequests: z.array(z.unknown()), evidence: z.object({ receipts: z.array(z.unknown()), images: z.array(z.unknown()), gaps: z.array(z.string()) }), blockers: z.array(z.string()) }),
    async run(context: IntakeContext, input) {
      const host = context.host();
      const snapshot = await host.call("snapshot", {});
      const rows = await context.db().select().from(workSubmissions).where(input.submissionId ? eq(workSubmissions.key, input.submissionId) : eq(workSubmissions.requestId, (input.requestId ?? "").toLowerCase()));
      if (!rows.length) throw new Response("Submission not found", { status: 404 });
      if (rows.length !== 1) throw conflict("Request ID is ambiguous; use the submission ID");
      const receipt = rows[0];
      // Historical readback checks current repository grants, independently of
      // project deletion/rerouting and future intake input schema revisions.
      const resolved = { repo: await submissionRepository(host, snapshot, receipt.repository) };
      const storedPackage = receipt.payload.workPackage;
      const decoded = storedPackage ? frozenWorkPackage.safeParse(storedPackage) : null;
      const base = { submissionId: receipt.key, repository: receipt.repository, issue: receipt.issue, workPackage: decoded?.success ? decoded.data : null };
      const empty = (blocker: string) => boundedWorkReadback({...base,run:null,pullRequests:[],evidence:{receipts:[],images:[],gaps:[]},blockers:[blocker]});
      if (!receipt.issue) return empty("Submission in progress or external write outcome uncertain");
      const runs = await issueRuns(host, String(resolved.repo.repositoryId), receipt.issue.number);
      const canonicalId = await foundryIssueRunId(snapshot.installation.id,String(resolved.repo.repositoryId),receipt.issue.number);
      const ids = [...new Set([...runs.map(run=>run.id),canonicalId])];
      const loaded = (await Promise.all(ids.map(id=>host.call("workflow.read",{id})))).filter(run=>run !== null);
      const latest = loaded.find(run=>run.run.status === "running") ?? loaded[0];
      if (!latest) return empty("No Foundry execution found");
      const candidates = loaded.flatMap(run=>outputChanges(run.outputs));
      const {pullRequests,blockers} = await pullRequestEvidence(host,resolved,receipt,candidates);
      const evidence = await Promise.all(loaded.map(run=>runEvidence(host,run.run.id)));
      const nativeImages = await nativeRunImages(context,loaded,pullRequests);

      if (decoded && !decoded.success) blockers.push("Stored frozen package version cannot be decoded");
      return boundedWorkReadback({ ...base, run: { id: latest.run.id, workflow: latest.run.workflowId, status: latest.run.status, url: runURL(context, latest.run.id, latest.run.workflowId) }, pullRequests, evidence: boundedEvidence(evidence.flatMap(item=>item.receipts),[...evidence.flatMap(item=>item.images),...nativeImages.images],[...evidence.flatMap(item=>item.gaps),...nativeImages.gaps]), blockers });
    },
  }),
  "work.submit": defineAction({
    description: submitDescription,
    access: "write",
    input: submitInput,
    output: submitOutput,
    run: submitWork,
  }),
};

/** The work.submit action and the submitWork mutation (src/server/graphql.ts) both run this. */
export async function submitWork(context: IntakeContext, input: z.output<typeof submitInput>): Promise<z.output<typeof submitOutput>> {
  // Rendered once, with its attribution, and bounded before any host call.
  const body = input.issue ? intakeComment(context, input) : intakeIssueBody(context, input);
  if (body.length > bodyLimit) throw new Response(`The submission renders to ${body.length} characters; the intake accepts at most ${bodyLimit}. Shorten the description, criteria or context.`, { status: 400 });
  if (input.workPackage && await workPackageDigest(input.workPackage) !== input.workPackage.digest)
    throw new Response("Work package digest does not match frozen content and references", { status: 400 });
  const { host, snapshot, repo } = await approvedTarget(context, input.target);
  const resolved = { repo };
  const operation = input.issue ? "issues.comment" : "issues.create";
  if (!repo.connection.operations.includes(operation)) throw new Response("Connector access unavailable",{status:403});
  const target = { connectionId: repo.connection.id, resource: String(repo.repositoryId) };
  const attachment = await validateAttachment(context,input,host,resolved);
  const {key,receipt,marker,execute} = await claimSubmission(context,input,host,resolved);
  let issue: z.infer<typeof submittedIssue>;
  if (receipt.issue) {
    issue = { ...receipt.issue, created: false };
  } else if (input.issue) {
    // Attaching records the whole submission and its trusted attribution on the issue.
    if (!attachment) throw conflict("Validated attachment required");
    await execute({ ...target, operation: "issues.comment", input: { number: input.issue, body, marker } });
    issue = attachment;
  } else {
    issue = z.object(submittedIssue.shape).parse(await execute({
      ...target, operation: "issues.create", input: { title: input.title, body, marker },
    }));
  }
  if (!receipt.issue) await context.db().update(workSubmissions).set({ issue }).where(eq(workSubmissions.key, key));
  // The manual-start path: the issue's running run if any (including an
  // operator's resume), else its deterministic run as recorded, else a new
  // run. Nothing finished is restarted. The issue's own webhook later finds
  // the running run and declines.
  return finishSubmission(context, host, snapshot, repo, issue, key);
}

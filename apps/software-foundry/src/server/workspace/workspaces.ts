import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import type { OperationOutput, WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import type { IssueReceipt } from "./forge";
import { foundryLandingWorkflow, landingContinuation } from "./landing-recovery";
import { workspaceAgentPermissions, workspaceCoordinatorPermissions, workspaceTarget } from "./execution";

type Unattended = WorkflowHost<"operator" | "interactive" | "event" | "finalize">;
type Editor = WorkflowHost<"operator" | "interactive">;
type Snapshot = OperationOutput<"snapshot">;
type Resume = { runId: string; requestId: string };
type IssueEvent = { repository: { id: number; full_name?: string }; issue: { number: number } };
export const foundryWorkspaceWorkflow = "issue-to-merge-actions-ci";
export const historicalFoundryWorkspaceWorkflow = "issue-to-merge-workspace";
export const foundryChecksWorkflow = "foundry-workspace-checks";
const roles = {
  triager: "triage",
  engineer: "implement",
  validator: "validate",
  reviewer: "review",
  repairer: "repair",
  lander: "land",
} as const;
/** The issue-to-merge workflows: checks in Actions (`foundryWorkspaceWorkflow`) or in a workspace. */
export const issueToMergeWorkflows = [foundryWorkspaceWorkflow, historicalFoundryWorkspaceWorkflow];
const issueWorkflows = [...issueToMergeWorkflows, foundryLandingWorkflow];

export function foundryChecks(repository: string) {
  // The apps monorepo gates on its Tooling CI jobs: root tests plus the
  // catalog and source app validation gates (each fans out per changed app).
  if (repository.toLowerCase() === "ai-outfitter/apps")
    return [
      { name: "test", commands: [["npm", "ci"], ["npm", "test"]] },
      ...["Catalog apps / CI gate", "Source apps / CI gate"].map((name) => ({
        name,
        commands: [["npm", "ci"], ["npm", "test", "--workspaces", "--if-present"]],
      })),
    ];
  if (repository.toLowerCase() !== "ai-outfitter/webapp")
    return [
      {
        name: "test",
        commands: [
          ["npm", "ci"],
          ["npm", "test"],
        ],
      },
    ];
  return [
    {
      name: "check",
      commands: [
        ["npm", "ci"],
        ["node", "scripts/ci-affected.mjs", "lint"],
        ["node", "scripts/ci-affected.mjs", "typecheck"],
        ["npm", "run", "test:unit"],
      ],
    },
    {
      name: "integration",
      commands: [
        ["npm", "ci", "--prefix", "workspace/runtime"],
        ["npm", "run", "apps:build"],
        ["npm", "run", "test:integration"],
      ],
    },
    {
      name: "browser-e2e (node)",
      commands: [
        ["npm", "exec", "--", "playwright", "install", "chromium"],
        ["npm", "run", "build:node"],
        [
          "node",
          "--test",
          "tests/node-proxy.integration.mjs",
          "tests/worker-bundle.integration.mjs",
        ],
        ["node", "--test", "tests/anonymous-onboarding.integration.mjs"],
        ["npm", "run", "test:e2e:apps"],
        ["npm", "run", "test:e2e:ui"],
        ["npm", "run", "test:e2e"],
      ],
    },
    {
      name: "browser-e2e (cloudflare)",
      commands: [
        ["npm", "run", "build"],
        [
          "node",
          "--test",
          "tests/scheduled-worker.integration.mjs",
          "tests/worker-inference-usage.integration.mjs",
          "tests/d1-sessions.integration.mjs",
          "tests/worker-bundle.integration.mjs",
        ],
        ["env", "TEST_TARGET=cloudflare", "npm", "run", "test:e2e"],
      ],
    },
  ];
}

/** The hosted binding target of one Foundry role: repository, token grants per
 * phase, the gateway operations its phases use, and Foundry's own settings. */
export function roleTarget(repository: string, resource: string, settings: z.input<typeof workspaceTarget>) {
  const policy = workspaceTarget.parse(settings);
  const write = ["implement", "repair"].includes(policy.role) ? "write" : "read";
  return {
    resource,
    repository,
    // A repository job files issues but never changes code.
    agentPermissions: { contents: write, pull_requests: write, issues: policy.role === "file-issues" ? "write" : write, ...workspaceAgentPermissions(policy.role) },
    coordinatorPermissions: workspaceCoordinatorPermissions(policy),
    // Read-only linkage queries when publishing evidence; ready/enqueue mutations when finalizing.
    graphql: ["publish", "finalize"] as ("publish" | "finalize")[],
    control: [
      ...(policy.role === "review"
        ? [
            { operation: "inspect-reviewer", phases: ["operator", "prepare"] as ("operator" | "prepare")[] },
            { operation: "inspect-preview-access", phases: ["prepare"] as "prepare"[] },
            { operation: "publish-review", phases: ["finalize"] as "finalize"[] },
          ]
        : []),
      ...(["validate", "review"].includes(policy.role) ? [{ operation: "inspect-preview", phases: ["finalize"] as "finalize"[] }] : []),
    ],
    settings: policy,
  };
}

/** Forges Foundry works on: GitHub, and an organization's Forgejo connection. */
const forges = new Set(["github", "forgejo"]);

/** The repository's one connection (the acting user's GitHub, the
 * organization's GitHub App or its Forgejo) and its immutable ID. */
async function approvedRepository(host: Editor, snapshot: Snapshot, repository: string) {
  const name = repository.toLowerCase();
  const matched = snapshot.connections.filter((connection) => forges.has(connection.provider) &&
    connection.repositories.some((listed) => listed.toLowerCase() === name));
  if (matched.length !== 1)
    throw new Response("Repository unavailable through your GitHub account or this organization's GitHub App or Forgejo connection", { status: 409 });
  const metadata = z.object({ id: z.number().int().positive(), full_name: z.string() })
    .parse(await host.call("repository.request", { connectionId: matched[0].id, path: `/repos/${name}` }));
  return { connection: matched[0], metadata };
}

/** Forge admission does not depend on an execution binding or event subscription. */
export async function submissionRepository(host: Editor, snapshot: Snapshot, repository: string) {
  const { connection, metadata } = await approvedRepository(host, snapshot, repository);
  return { name: metadata.full_name, path: `/repos/${metadata.full_name}`, repositoryId: metadata.id, connection };
}

/** Approve the bindings and subscription Foundry needs for one repository: an
 * organization owner/admin turns a repository on from Foundry (EnableRepository),
 * and the platform applies its own approval checks.
 * Identical current bindings are reused; the platform applies its own approval checks.
 * Issue creation and comments need no separate approval: the platform checks
 * the caller, the connection's enabled repositories and Foundry's manifest. */
export async function configureFoundryWorkspaces(
  host: WorkflowHost<"interactive">,
  repository: string,
  reviewer: string,
  model = "gpt-6-luna",
  /** Where checks run: GitHub Actions, or the approved commands in a workspace
   * (a forge without Actions, such as the sealed box's Forgejo). */
  ci: "actions" | "workspace" = "actions",
) {
  const snapshot = await host.call("snapshot", {});
  const { connection, metadata } = await approvedRepository(host, snapshot, repository);
  const resource = String(metadata.id);
  const base = { checks: foundryChecks(repository), ci, reviewer, mergeQueue: repository.toLowerCase() === "ai-outfitter/webapp" };
  async function bindingFor(workflowId: string, actor: string, role: (typeof roles)[keyof typeof roles], ci: "actions" | "workspace" = base.ci) {
    const prompt = `You are the ${role} agent for an Outfitter Software Foundry workflow. Complete only your assigned node, substantiate every external effect, and follow the repository's applicable instructions.`;
    const binding = await host.call("binding.approve", {
      workflowId,
      actor,
      label: `Workspace ${role}`,
      workspace: roleTarget(metadata.full_name, resource, { ...base, ci, role }),
      context: { model, profile: { id: `foundry-${role}`, digest: await sha256Hex(prompt), systemPrompt: prompt }, capabilities: [] },
    });
    return binding.id;
  }
  const inputs: Record<string, string> = {};
  for (const [actor, role] of Object.entries(roles))
    inputs[`triage.inputs.${actor}Binding`] = await bindingFor(foundryWorkspaceWorkflow, actor, role);
  await bindingFor(foundryLandingWorkflow, "lander", "land");
  // Merge-group checks run the approved commands in a workspace, not in Actions.
  await bindingFor(foundryChecksWorkflow, "validator", "validate", "workspace");
  // One subscription per repository: this replaces a historical workspace-CI subscription.
  const subscription = await host.call("subscription.save", { connectionId: connection.id, resource, workflowId: foundryWorkspaceWorkflow, inputs, enabled: true });
  return { subscriptionId: subscription.id, repository: metadata.full_name, resource, workflow: foundryWorkspaceWorkflow };
}

/** Foundry's repository jobs, each with the one actor that reads the repository
 * and files issues. They run in a workspace with an approved binding, like every
 * other Foundry role, so the binding ID travels in the run's inputs. */
export const foundryJobs = {
  "dependency-review": "reviewer",
  "architecture-reanalysis": "architect",
  "ui-review": "reviewer",
} as const;
export type FoundryJob = keyof typeof foundryJobs;
export const jobBindingInput = (job: FoundryJob) => `analyze.inputs.${foundryJobs[job]}Binding`;

/** Approve (or reuse) the job's workspace binding on one repository: the run
 * inputs a manual start or a saved schedule needs. A job's issues are fixed by
 * issue-to-merge, so the repository must have Foundry turned on first. */
async function jobInputs(host: Editor, job: FoundryJob, repository: string, model = "gpt-6-luna") {
  const snapshot = await host.call("snapshot", {});
  const { metadata } = await approvedRepository(host, snapshot, repository);
  const subscription = snapshot.subscriptions.find((candidate) => candidate.enabled && candidate.workflowId === foundryWorkspaceWorkflow &&
    candidate.resource === String(metadata.id));
  if (!subscription)
    throw new Response(`Turn Foundry on for ${metadata.full_name} first (RepositoryChanges enable), so the job's issues are fixed and merged`, { status: 409 });
  const prompt = "You are the analyze agent for an Outfitter Software Foundry repository job. Read the repository, file only the issues your instructions call for, and never change code.";
  const binding = await host.call("binding.approve", {
    workflowId: job,
    actor: foundryJobs[job],
    label: "Workspace analyze",
    workspace: roleTarget(metadata.full_name, String(metadata.id), { role: "file-issues", checks: foundryChecks(metadata.full_name), ci: "actions", reviewer: "vega" }),
    context: { model, profile: { id: "foundry-analyze", digest: await sha256Hex(prompt), systemPrompt: prompt }, capabilities: [] },
  });
  // The job's finalize starts issue-to-merge for each issue it filed, with the
  // repository's approved issue-to-merge bindings.
  const fix: JobFix = { installation: snapshot.installation.id, resource: subscription.resource, inputs: subscription.inputs as Record<string, string> };
  return { repository: metadata.full_name, inputs: {
    "analyze.inputs.repository": metadata.full_name, [jobBindingInput(job)]: binding.id, "analyze.inputs.fix": fix } };
}

/** Where a repository job's issues go to be fixed: issue-to-merge on the job's repository. */
export type JobFix = { installation: string; resource: string; inputs: Record<string, string> };

/** Start issue-to-merge for one issue a repository job filed, under the
 * issue's deterministic run id, so a retried finalize or an issue webhook
 * reuses the same run. */
export async function startJobFix(host: Unattended, fix: JobFix, repository: { id: number; name: string },
  issue: { number: number; title: string; body: string; url: string }) {
  const id = await foundryIssueRunId(fix.installation, fix.resource, issue.number);
  return launchFoundryWorkspaceIssue(host, { resource: fix.resource, inputs: fix.inputs },
    { action: "opened", repository: { id: repository.id, full_name: repository.name },
      issue: { number: issue.number, title: issue.title, body: issue.body, html_url: issue.url, state: "open" } }, id);
}

/** Failed fix runs an issue gets before its job closes it as not fixable. */
export const jobFixAttempts = 3;
/** Most fixes one job run restarts, so a backlog drains over several runs. */
const jobRetriesPerRun = 5;

/** Every job run also finishes earlier work: each open issue whose last Foundry
 * fix failed starts again on the same branch, as does an issue Foundry opened
 * whose fix never started; one that has failed `jobFixAttempts` times is closed with its runs. */
export async function retryJobFixes(host: Unattended, fix: JobFix, repository: { id: number; name: string },
  forge: { openIssues(): Promise<(IssueReceipt & { byFoundry: boolean })[]>; close(number: number, comment: string, reason: "not_planned"): Promise<void> },
  skip: ReadonlySet<number>) {
  const retried = [];
  const closed = [];
  const issues = (await forge.openIssues()).filter((issue) => !skip.has(issue.number));
  const runsOf = new Map<number, Awaited<ReturnType<typeof issueRuns>>>();
  if (issues.length)
    for (const run of await issueRuns(host, fix.resource, issues.map((issue) => issue.number)))
      runsOf.set(Number(run.subject), [...runsOf.get(Number(run.subject)) ?? [], run]);
  for (const issue of issues) {
    if (retried.length >= jobRetriesPerRun) break;
    const runs = (runsOf.get(issue.number) ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
    if (runs.length ? runs[0].status !== "failed" : !issue.byFoundry) continue;
    const failures = runs.filter((run) => run.status === "failed");
    if (failures.length >= jobFixAttempts) {
      await forge.close(issue.number, `Foundry could not fix this in ${failures.length} attempts (runs ${
        failures.map((run) => run.id).join(", ")}), so it is closed. A later job run files it again if it still applies.`, "not_planned");
      closed.push({ number: issue.number, url: issue.url, title: issue.title });
      continue;
    }
    // The retry keeps the failed run's branch, so its open pull request carries on.
    const prior = runs[0] && await host.call("workflow.read", { id: runs[0].id });
    const event = prior?.inputs["triage.inputs.event"] as { sourceRunId?: string } | undefined;
    const id = await foundryIssueRunId(fix.installation, fix.resource, issue.number, `retry-${failures.length}`);
    const started = await launchFoundryWorkspaceIssue(host, { resource: fix.resource, inputs: fix.inputs },
      { action: "opened", repository: { id: repository.id, full_name: repository.name },
        issue: { number: issue.number, title: issue.title, body: issue.body, html_url: issue.url, state: "open" },
        ...(runs[0] ? { previousRunId: runs[0].id, sourceRunId: z.uuid().parse(event?.sourceRunId ?? runs[0].id) } : {}) },
      id, undefined, runs);
    retried.push({ number: issue.number, url: issue.url, title: issue.title, fixRun: started.id });
  }
  return { retried, closed };
}

/** Start a repository job now. */
export async function runFoundryJob(host: Editor, job: FoundryJob, repository: string) {
  const { repository: name, inputs } = await jobInputs(host, job, repository);
  const run = crypto.randomUUID();
  await host.call("workflow.start", { workflow: job, id: run, inputs });
  return { job, repository: name, run };
}

/** Save the job's schedule (one per job) on a repository, on its declared cadence. */
export async function scheduleFoundryJob(host: Editor, job: FoundryJob, repository: string, enabled = true) {
  const { repository: name, inputs } = await jobInputs(host, job, repository);
  const schedule = await host.call("schedule.save", { workflow: job, inputs, enabled, timezone: "UTC" });
  return { job, repository: name, schedule: schedule.id, enabled: schedule.enabled };
}

/** The current approved binding of `workflowId`/`actor` for one repository. */
async function currentBinding(host: Unattended, snapshot: Snapshot, workflowId: string, actor: string, resource: string) {
  const candidates = snapshot.bindings.filter((binding) => binding.workflowId === workflowId && binding.actor === actor &&
    binding.enabled);
  const bound = await Promise.all(candidates.map((binding) => host.call("repository.read", { bindingId: binding.id })));
  const index = bound.findIndex((repo) => String(repo.repositoryId) === resource);
  if (index >= 0) return candidates[index];
  throw new Response(`Approved ${workflowId} ${actor} binding unavailable`, { status: 409 });
}

/** Stable per installation/repository/issue, so repeated manual starts converge. */
export async function foundryIssueRunId(
  installationId: string,
  resource: string,
  issue: number,
  resumeKey?: string,
) {
  const hash = await sha256Hex(
    JSON.stringify([
      foundryWorkspaceWorkflow,
      installationId,
      resource,
      issue,
      resumeKey ?? "opened",
    ]),
  );
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Runs of one repository's issue across Foundry's issue workflows, newest first. */
export function issueRuns(host: Unattended, resource: string, issue: number | number[]) {
  return host.call("workflow.references", {
    selectors: [
      { slot: "triage.inputs.event", key: "$.repository.id", subject: "$.issue.number", label: "$.issue.title" },
      { slot: "land.inputs.event", key: "$.repository.id", subject: "$.issue.number", label: "$.issue.title" },
    ],
    key: resource,
    subjects: Array.isArray(issue) ? issue : [issue],
    workflows: issueWorkflows,
    limitPerSubject: 10,
  });
}

/** Previously recorded runs remain visible even if an upgrade invalidated the
 * execution binding. Looking up work never grants an old binding new authority. */
export async function existingFoundryIssueRun(host: Editor, installationId: string, resource: string, issue: number) {
  const running = (await issueRuns(host, resource, issue)).find((run) => run.status === "running");
  if (running) return { id: running.id, workflow: foundryWorkspaceWorkflow, created: false, existing: true, status: running.status };
  const id = await foundryIssueRunId(installationId, resource, issue);
  const prior = await host.call("workflow.read", { id });
  return prior ? { id, workflow: prior.run.workflowId, created: false, existing: true, status: prior.run.status } : null;
}

/** A prior run that may be resumed: the same issue, settled, failed or awaiting details. */
function assertResumable(prior: OperationOutput<"workflow.read">, resource: string, issue: number) {
  const priorEvent = prior?.inputs[
    prior.run.workflowId === foundryLandingWorkflow ? "land.inputs.event" : "triage.inputs.event"
  ] as IssueEvent | undefined;
  if (
    !prior ||
    !issueWorkflows.includes(prior.run.workflowId) ||
    String(priorEvent?.repository?.id) !== resource ||
    priorEvent?.issue?.number !== issue ||
    prior.run.status === "running" ||
    (prior.run.status !== "failed" &&
      (prior.outputs["triage.outputs.result"]?.value as { ready?: boolean } | undefined)?.ready !== false)
  )
    throw new Response(
      "Only the matching issue awaiting details or attention can be resumed",
      { status: 409 },
    );
  return prior;
}

/** Resuming reviewed work lands it in the landing workflow instead of starting over. */
async function landingInputs(host: Editor, snapshot: Snapshot, resource: string, payload: IssueEvent, resume: Resume) {
  const prior = assertResumable(await host.call("workflow.read", { id: resume.runId }), resource, payload.issue.number);
  const finalReview = prior.attempts.find((attempt) => attempt.nodeId === "review-final" && attempt.state === "failed");
  const continuation = landingContinuation({ run: prior.run, state: { inputs: prior.inputs, rows: prior.outputs } }, finalReview?.failure);
  if (!continuation) return undefined;
  const lander = await currentBinding(host, snapshot, foundryLandingWorkflow, "lander", resource);
  return {
    "land.inputs.landerBinding": lander.id, "land.inputs.event": { ...payload, sourceRunId: continuation.branchRunId },
    "land.inputs.previous": continuation.previous as never, "land.inputs.sourceRunId": continuation.sourceRunId as string,
    "land.inputs.previousRunId": continuation.previousRunId,
  };
}

/** Start the issue workflow under `id` unless the issue already has a running run,
 * which is returned instead. A resume of reviewed work lands it. */
export async function launchFoundryWorkspaceIssue(
  host: Unattended,
  subscription: { resource: string; inputs: Record<string, unknown> },
  event: unknown,
  id: string,
  resume?: { host: Editor; snapshot: Snapshot; request: Resume },
  /** The issue's runs when the caller already read them. */
  known?: Awaited<ReturnType<typeof issueRuns>>,
) {
  const payload = event as IssueEvent;
  if (
    !payload?.repository?.id ||
    !payload.issue?.number ||
    String(payload.repository.id) !== subscription.resource
  )
    throw new Response("Issue does not match enabled repository", {
      status: 403,
    });
  const running = (known ?? await issueRuns(host, subscription.resource, payload.issue.number)).find((run) => run.status === "running");
  if (running && running.id !== id) return { id: running.id, workflow: foundryWorkspaceWorkflow, created: false, existing: true, status: running.status };
  const landing = resume ? await landingInputs(resume.host, resume.snapshot, subscription.resource, payload, resume.request) : undefined;
  let resumedEvent;
  if (resume && !landing) {
    const prior = assertResumable(await resume.host.call("workflow.read", { id: resume.request.runId }), subscription.resource, payload.issue.number);
    const previous = prior.inputs[prior.run.workflowId === foundryLandingWorkflow ? "land.inputs.event" : "triage.inputs.event"] as { sourceRunId?: string };
    resumedEvent = { ...payload, previousRunId: resume.request.runId,
      sourceRunId: z.uuid().parse(previous?.sourceRunId ?? prior.run.id) };
  }
  const started = await host.call("workflow.start", landing
    ? { workflow: foundryLandingWorkflow, id, inputs: landing }
    : {
        workflow: foundryWorkspaceWorkflow,
        id,
        inputs: {
          ...(subscription.inputs as Record<string, never>),
          "triage.inputs.event": (resumedEvent ?? payload) as never,
        },
      });
  return { ...started, existing: false };
}

/** The enabled issue subscription whose triager binding is approved for `repository`. */
export async function resolveFoundryRepository(host: Editor, snapshot: Snapshot, repository: string,
  knownRepository?: Awaited<ReturnType<typeof submissionRepository>>) {
  const candidates = snapshot.subscriptions.flatMap((subscription) => {
    const bindingId = subscription.inputs["triage.inputs.triagerBinding"];
    return subscription.enabled && subscription.workflowId === foundryWorkspaceWorkflow && typeof bindingId === "string" &&
      snapshot.bindings.some((binding) => binding.id === bindingId && binding.enabled) ? [{ subscription, bindingId }] : [];
  });
  // The user's connection and the subscription's event-routing record have
  // different identities. Match the immutable repository, not connection IDs.
  const repo = knownRepository ?? await submissionRepository(host, snapshot, repository);
  const candidate = candidates.find(({ subscription }) => subscription.resource === String(repo.repositoryId));
  if (candidate) {
    const bound = await host.call("repository.read", { bindingId: candidate.bindingId });
    if (bound.repositoryId !== repo.repositoryId) return null;
  }
  return candidate ? { ...candidate, repo } : null;
}

export type ResolvedFoundryRepository = NonNullable<Awaited<ReturnType<typeof resolveFoundryRepository>>>;

/** An editor starts (or resumes) Foundry on an existing open issue. A start
 * returns the issue's running run (for example an operator's resume) or else its
 * own deterministic run in any state, read directly by ID, without resubmitting
 * the issue's (possibly changed) inputs or another member as creator. Only an
 * explicit resume restarts.
 * `known` is a server caller's already-resolved snapshot and repository. */
export async function startExistingFoundryIssue(
  host: Editor,
  repository: string,
  number: number,
  resume?: Resume,
  known?: { snapshot: Snapshot; resolved: ResolvedFoundryRepository },
) {
  const snapshot = known?.snapshot ?? await host.call("snapshot", {});
  const resolved = known?.resolved ?? await resolveFoundryRepository(host, snapshot, repository);
  if (!resolved)
    throw new Response("Workspace workflow is not enabled for this repository", { status: 409 });
  const { subscription, repo } = resolved;
  const id = await foundryIssueRunId(snapshot.installation.id, subscription.resource, number, resume?.requestId);
  const runs = resume ? undefined : await issueRuns(host, subscription.resource, number);
  if (runs) {
    const running = runs.find((run) => run.status === "running");
    if (running) return { id: running.id, workflow: foundryWorkspaceWorkflow, created: false, existing: true, status: running.status };
    const prior = await host.call("workflow.read", { id });
    if (prior) return { id, workflow: prior.run.workflowId, created: false, existing: true, status: prior.run.status };
  }
  const issue = z.object({ state: z.string(), title: z.string().optional(), pull_request: z.unknown().optional() }).passthrough()
    .parse(await host.call("repository.request", { connectionId: repo.connection.id, path: `${repo.path}/issues/${number}` }));
  if (issue.pull_request || issue.state !== "open")
    throw new Response("An open issue is required", { status: 409 });
  // A new or just-claimed run is running; the launch's own running-run answer keeps its status.
  return { status: "running", ...await launchFoundryWorkspaceIssue(
    host,
    subscription,
    { action: "opened", repository: { id: repo.repositoryId, full_name: repo.name }, issue: { ...issue, number } },
    id,
    resume && { host, snapshot, request: resume },
    runs,
  ) };
}

/** Signed merge-group input selects the approved check-only workflow, never an
 * agent plan, under the merge-check validator binding configuration approved. */
export async function launchFoundryMergeChecks(
  host: WorkflowHost<"event" | "operator">,
  resource: string,
  event: unknown,
  id: string,
) {
  const payload = event as {
    repository: { id: number };
    merge_group: { head_sha: string; head_ref: string };
  };
  if (
    String(payload.repository?.id) !== resource ||
    !/^[a-f0-9]{40}$/.test(payload.merge_group?.head_sha)
  )
    throw new Response("Invalid merge-group repository or commit", {
      status: 403,
    });
  const validator = await currentBinding(host, await host.call("snapshot", {}), foundryChecksWorkflow, "validator", resource);
  return host.call("workflow.start", {
    workflow: foundryChecksWorkflow,
    id,
    inputs: {
      "validate.inputs.validatorBinding": validator.id,
      "validate.inputs.event": event as never,
      "validate.inputs.previous": {
        ready: true,
        summary: "Validate the signed merge-group commit.",
        candidate: {
          number: 0,
          headSha: payload.merge_group.head_sha,
          branch: payload.merge_group.head_ref,
          url: "",
        },
      },
    },
  });
}

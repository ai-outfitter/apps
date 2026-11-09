import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import type { OperationOutput, WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { foundryLandingWorkflow, landingContinuation } from "./landing-recovery";
import { workspaceAgentPermissions, workspaceCoordinatorPermissions, workspaceTarget } from "./execution";

type Unattended = WorkflowHost<"operator" | "interactive" | "event">;
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
    agentPermissions: { contents: write, pull_requests: write, issues: write, ...workspaceAgentPermissions(policy.role) },
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

/** Approve the bindings and subscription Foundry needs for one repository.
 * Identical current bindings are reused; the platform applies its own approval checks.
 * Issue creation and comments need no separate approval: the platform checks
 * the caller, the connection's enabled repositories and Foundry's manifest. */
export async function configureFoundryWorkspaces(
  host: WorkflowHost<"operator">,
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
export function issueRuns(host: Unattended, resource: string, issue: number) {
  return host.call("workflow.references", {
    selectors: [
      { slot: "triage.inputs.event", key: "$.repository.id", subject: "$.issue.number", label: "$.issue.title" },
      { slot: "land.inputs.event", key: "$.repository.id", subject: "$.issue.number", label: "$.issue.title" },
    ],
    key: resource,
    subjects: [issue],
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

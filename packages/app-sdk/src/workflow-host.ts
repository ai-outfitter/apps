import { residentTaskState } from "@ai-outfitter/workflow-core/execution";
import { StepInference, slug } from "@ai-outfitter/workflow-core/schema";
import { z } from "zod";
import { actionDescriptor, actionName, workContextInput, workContextResult } from "./actions";
import { entityGet, entityQuery, entityRecord, entityRef, entityType, entityUpdate, entityWrite } from "./entities";
import { hostPhases } from "./host-operation";
import { platformRecordOperations } from "./platform-records";
import { appActor, readJSON } from "./server";
import { threadOperations } from "./threads";
import { sessionEntry, workflowSession } from "./workflow-session";

export { type HostOperation, hostOperation, runningPhases } from "./host-operation";

/** Installed-app workflow host contract. The platform dispatches a workflow phase
 * to the app over trusted RPC props, and the app calls back through the typed
 * operations below. The host derives tenant, package and execution authority
 * from the dispatch scope; apps never receive primary-database, storage or
 * provider credentials, and nothing in a request body can widen that scope. */

/** Reserved callback route. Platform ingress refuses it for every method; only
 * platform Worker dispatch reaches it, and only dispatch supplies host props. */
export const workflowHostPath = "/api/internal/workflow-host/v1";

/** The workload identity issuer of workspace executor bindings; the host sets it on every binding it approves. */
export const workspaceIssuer = "https://ai-outfitter.com/workspace-executor";

export const workflowPhases = hostPhases;

/** A package may call the `agent-task.*` operations: ordinary A2A tasks to the
 * operator-held gateway targets configured for exactly this organization
 * installation. Catalog packages only; a runtime package cannot declare it. */
export const agentTaskCapability = "agent-tasks.dispatch";
/** A package may keep platform-scheduled invocations of its own `invocation` phase. */
export const invocationCapability = "invocations.schedule";
/** A package may read a verified resident's assigned work (`agent-work.*`):
 * which installations publish `work.list` and their answers, as that resident,
 * only when the operator's resident grant explicitly names this installation.
 * Only assigned-work discovery and read-only context are reachable. Catalog packages only. */
export const agentWorkCapability = "agent-work.discover";
/** A package may list its member's own routines (their personal workflow schedules)
 * and runs, turn a task on as a routine, and pause, resume or rewrite one. Running,
 * deleting and cancelling go through the platform documents (`platform.documents`).
 * Only on a user's own installation, for that user. Catalog packages only. */
export const routinesCapability = "routines.manage";
/** A package may run the platform's own documents (scope and app "platform", such as
 * Schedules, WorkflowRuns, ScheduleChanges and WorkflowRunChanges) as its member, through
 * the same MCP tools their MCP client uses. On a user's own installation it reads
 * every scope the member can; on an organization's, only that organization. Writes
 * are limited to schedule, task and run changes. Catalog packages only. */
export const platformDocumentsCapability = "platform.documents";
export type WorkflowPhase = (typeof workflowPhases)[number];
const phase = z.enum(workflowPhases);

const id = z.string().min(1).max(128);
const runId = z.uuid();
const json = z.json();
/** A JSON object: phase inputs and results, run inputs, provider payloads. */
export const jsonObject = z.record(z.string(), json);
const slot = z.string().max(128).regex(/^[a-z][a-z0-9-]*\.inputs\.[A-Za-z][A-Za-z0-9]*$/);
const selectorPath = z.string().max(256).regex(/^\$(?:\.[A-Za-z][A-Za-z0-9_]*)+$/);

/** The authority a dispatch carries. The platform sets it; apps only hold a stub bound to it. */
export const workflowHostScope = z.strictObject({
  /** The owning organization; null on a user's own installation. */
  organizationId: id.nullable(),
  installationId: id,
  userId: id,
  /** Verified principal supplied only by the platform authentication adapter. */
  actorId: z.string().min(1).max(300).optional(),
  /** Canonical record of an authenticated workload; supplied only after verification. */
  actorRef: entityRef.optional(),
  /** Opaque ID of a current server-managed app access grant, not a role grant. */
  residentGrant: z.union([z.uuid(), z.string().regex(/^managed:[a-zA-Z0-9_-]+:[a-f0-9-]{36}$/)]).optional(),
  packageHash: id,
  phase,
  expiresAt: z.number().int(),
  subscriptionId: id.optional(),
  /** `schedule` only: the installation schedule this occurrence is for. */
  scheduleId: id.optional(),
  /** `invocation` only: the enabled app invocation this occurrence is for. Its
   * `userId` is that invocation's service principal, never a member. */
  invocationId: id.optional(),
  /** `interactive` only: the member's own state-changing request (not a page
   * read), which alone may run member-initiated connector writes. */
  initiation: z.literal("member").optional(),
  /** `interactive` only: the platform's installation setup after a deployment.
   * `userId` is the deployment service actor, which has editor standing on the
   * owning organization's installations without a membership. */
  setup: z.literal(true).optional(),
  /** Platform-verified registered task context; cancellation checkpoint, never authority. */
  taskRunId: id.optional(),
  runId: id.optional(),
  attemptId: runId.optional(),
  leaseId: id.optional(),
  finalizationOwner: id.optional(),
  /** The caller that initiated the chain, for attribution only; never authority. */
  originActor: appActor.optional(),
  /** `interactive` only: the verified app or client that dispatched this request for
   * the member, when it was not the member's own request to this app (an app-to-app
   * call, a thread reply another app sent, an MCP action). The platform keeps the
   * first such caller across later hops; personal-authority host operations refuse it. */
  viaActor: appActor.optional(),
});
export type WorkflowHostScope = z.infer<typeof workflowHostScope>;

const repositoryTarget = {
  /** An enabled executor binding of this installation. Attempt-scoped phases use the attempt's binding. */
  bindingId: id.optional(),
};
const runSummary = z.object({
  id,
  workflowId: id,
  status: z.enum(["running", "complete", "failed"]),
  createdBy: id,
  createdAt: z.number(),
  updatedAt: z.number(),
  /** "owner": only its creator may see it (other members never receive it); readers must keep it private. */
  visibility: z.enum(["owner", "organization"]).default("organization"),
});
const workflowActivity = z.object({
  id,
  workflowId: id,
  status: z.enum(["running", "complete", "failed"]),
  createdBy: id,
  createdAt: z.number(),
  updatedAt: z.number(),
  /** "owner": only its creator may see it (other members never receive it); readers must keep it private. */
  visibility: z.enum(["owner", "organization"]).default("organization"),
  inputs: jsonObject,
  /** With `steps`: ids of the steps whose outputs are complete, in no order. Never their values. */
  completedSteps: z.array(z.string()).optional(),
});
const publishedArtifact = z.object({
  id,
  runId: id,
  name: z.string(),
  contentType: z.string(),
  revision: z.string().nullable(),
  url: z.string(),
  createdAt: z.number(),
});
export type PublishedArtifact = z.infer<typeof publishedArtifact>;

/** An installation schedule as the host reports it. */
/** A recurring task a member's routine carries out: what `routines.create` turns on. */
export const routineTask = z.strictObject({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(800),
  /** How often it runs, in words: "Every Monday", "Daily at 8am". Weekday mornings when unrecognised. */
  cadence: z.string().trim().max(80).optional(),
  steps: z.array(z.string().trim().min(1).max(300)).max(5).optional(),
  evidence: z.string().trim().max(300).optional(),
});
export type RoutineTask = z.infer<typeof routineTask>;
/** One of the member's routines (`routines.manage`). Times are epoch milliseconds. */
const memberRoutine = z.object({
  id,
  workflowId: id,
  name: z.string(),
  /** The cron in words, e.g. "Weekdays at 13:00 America/Chicago". */
  cadence: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
  lastRunId: id.nullable(),
  lastRunStatus: z.enum(["running", "complete", "failed"]).nullable(),
  lastOutcome: z.string().nullable(),
  /** A recurring task's task, which `routines.update` can rewrite; null for any other workflow. */
  task: routineTask.nullable(),
});
export type MemberRoutine = z.infer<typeof memberRoutine>;
/** One of the member's runs (`routines.manage`). */
const memberRun = z.object({
  id,
  workflowId: id,
  name: z.string(),
  status: z.enum(["running", "complete", "failed"]),
  /** The app that started it, or null for a routine or chat run. */
  installationId: id.nullable(),
  scheduleId: id.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type MemberRun = z.infer<typeof memberRun>;
const installationSchedule = z.object({
  id,
  workflowId: id,
  cron: z.string(),
  timezone: z.string(),
  inputs: jsonObject,
  /** The connection and resource the schedule's occurrences may use, or null. */
  connectionId: id.nullable(),
  resource: z.string().nullable(),
  createdBy: id,
  enabled: z.boolean(),
  nextRunAt: z.number(),
  lastRunAt: z.number().nullable(),
  lastRunId: id.nullable(),
  lastOutcome: z.string().nullable(),
});
export type InstallationSchedule = z.infer<typeof installationSchedule>;

/** Every phase that acts for a member or an attempt. A platform-scheduled
 * `invocation` acts for no member, so an operation is callable there only when
 * it names `invocation` explicitly; a new phase is a member phase unless excluded here. */
const memberPhases = workflowPhases.filter((current): current is Exclude<WorkflowPhase, "invocation"> => current !== "invocation");
const unattended = ["event", "operator", "interactive"] as const;
/** Ordinary agent tasks: a member's request to the app, or its scheduled invocation. */
const agentTasks = ["interactive", "invocation"] as const;
/** Delegated work reads: an owner verifying a delegation, or the scheduled scan. */
const agentWork = ["interactive", "invocation"] as const;
const agentTarget = { targetId: z.string().min(1).max(128), revision: z.string().min(1).max(128) };
/** The A2A task state the resident's task plane reports. */
export const agentTaskState = residentTaskState;
export type AgentTaskState = z.infer<typeof agentTaskState>;
/** The largest prompt `agent-task.send` carries, as UTF-8 bytes of its JSON
 * string form (escapes included), so it also fits the transport's request bound. */
export const agentTaskPromptBytes = 256 * 1024;
const agentTaskRef = z.strictObject({ ...agentTarget, correlationId: z.uuid(), taskId: z.string().min(1).max(2048) });
export const invocationName = z.string().min(3).max(64).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/);
/** An installation's platform-scheduled invocation as the host reports it. */
const appInvocation = z.object({
  id,
  name: invocationName,
  intervalMinutes: z.number().int(),
  enabled: z.boolean(),
  /** The editor who last enabled or changed it; occurrences pause once they can no longer change the app. */
  enabledBy: id,
  nextRunAt: z.number(),
  lastRunAt: z.number().nullable(),
  lastOutcome: z.string().nullable(),
});
export type AppInvocation = z.infer<typeof appInvocation>;
/** Phases that run an app's own workflow steps: deliveries, configuration, member requests and schedules. */
const running = ["event", "operator", "interactive", "schedule"] as const;
type Operation = { phases: readonly WorkflowPhase[]; input: z.ZodType; output: z.ZodType };
const operation = <const P extends readonly WorkflowPhase[], I extends z.ZodType, O extends z.ZodType>(
  phases: P, input: I, output: O,
) => ({ phases, input, output }) satisfies Operation;

/** Every operation an app may call, the phases it may call it in, and its
 * input and output schemas. The host validates both sides against this map. */
export const residentRuntime = z.object({
  status: z.enum(["provisioning", "ready", "offline", "blocked"]), message: z.string(),
  resource: z.object({ agentName: z.string(), agentUid: z.string(), organizationUid: z.string(), operatorOrganization: z.string(), connectionId: z.string(), clusterId: z.string() }).optional(),
  target: z.object({ targetId: z.string(), revision: z.string() }).optional(),
});
const residentLifecycleInput = { residentId: z.uuid(), agentName: z.string().max(57).optional(), expectedAgentUid: z.string().max(128).optional() };
const workDelegation = z.union([z.uuid(), z.string().regex(/^managed:[a-f0-9-]{36}$/)]);

const coreOperations = {
  "resident.runtimes": operation(["operator", "interactive"], z.strictObject({}), z.object({ runtimes: z.array(z.object({ agentName: z.string(), agentUid: z.string(), profileRef: z.string() })) })),
  "resident.reconcile": operation(agentTasks, z.strictObject({ ...residentLifecycleInput, profileRef: z.string().min(1).max(128).optional(), browserRequested: z.boolean().optional(), desiredRevision: z.number().int().positive() }), residentRuntime),
  "resident.inspect": operation(["operator", "interactive"], z.strictObject(residentLifecycleInput), residentRuntime),
  "resident.task-authority": operation(agentTasks, z.strictObject({ userId: id, actor: appActor }), z.object({ permitted: z.boolean() })),
  /** Scoped cross-app entity access. The host requires entities.read/write on
   * the calling package; the target app still enforces the actor's role. */
  /** Current authenticated actor, resolved fresh from trusted dispatch identity. No caller-selected user. */
  "identity.current": operation(running, z.strictObject({}), z.object({ id, name: z.string(), email: z.string() })),
  "identity.resolve": operation(running, z.strictObject({ installationId: id }), z.object({ holderId: id, kind: z.enum(["human", "agent"]), principalId: z.string() }).nullable()),
  "identity.list": operation(["interactive", "operator"], z.strictObject({ installationId: id }), z.array(z.object({ id, holderId: id, kind: z.enum(["human", "agent"]), principalId: z.string() }))),
  "identity.link": operation(["interactive", "operator"], z.strictObject({ installationId: id, holderId: id, principalId: z.string().min(1).max(300), kind: z.enum(["human", "agent"]) }), z.object({ linked: z.boolean() })),
  "identity.unlink": operation(["interactive", "operator"], z.strictObject({ installationId: id, holderId: id }), z.object({ removed: z.boolean() })),
  "entities.types": operation(running, z.strictObject({ installationId: id.optional(), template: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(128).optional() }), z.array(entityType.extend({ installationId: id, hostname: z.string().nullable().optional(), template: z.string().optional(), slug: z.string().optional() }))),
  "entities.list": operation(running, entityQuery.extend({ installationId: id }), z.array(entityRecord)),
  "entities.get": operation(running, entityGet.extend({ installationId: id }), entityRecord),
  "entities.create": operation(running, entityWrite.extend({ installationId: id }), entityRecord),
  "entities.update": operation(running, entityUpdate.extend({ installationId: id }), entityRecord),
  /** Actions other installations of the same owner publish (`actions.invoke`).
   * The target app enforces the member's role; calls are attributed to this app. */
  "actions.list": operation(running, z.strictObject({ installationId: id.optional(), template: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(128).optional() }), z.array(z.object({ installationId: id, actions: z.array(actionDescriptor) }))),
  "actions.call": operation(running, z.strictObject({ installationId: id, action: actionName, input: json, readOnly: z.boolean().optional(), maxResponseBytes: z.number().int().min(1).max(8 * 1024 * 1024).optional() }).refine(value => value.maxResponseBytes === undefined || value.readOnly === true, "A custom response budget requires a read-only call"), json),
  /** Approved bindings, subscriptions and usable connections of this installation. Editors only. */
  snapshot: operation(unattended, z.strictObject({}), z.object({
    installation: z.object({ id, activeHash: z.string().nullable(), hostname: z.string().nullable(), workflows: z.array(id) }),
    bindings: z.array(z.object({ id, workflowId: id, actor: id, kind: z.enum(["external", "resident"]), label: z.string(), revision: z.string(), packageHash: z.string(), enabled: z.boolean() })),
    subscriptions: z.array(z.object({ id, workflowId: id, connectionId: id, resource: z.string(), enabled: z.boolean(), inputs: jsonObject })),
    /** The active connections this installation may use for the scope's member:
     * its organization's own, and the member's own personal connections where
     * the installation is (on a user's own installation, only those). `owner`
     * says which; `operations` are the ones this package's manifest declares on
     * the provider. `resource` is a personal connection's one resource (its
     * whole account or import). A personal connection serves only its owner. */
    connections: z.array(z.object({ id, provider: z.string(), label: z.string().optional(), revision: z.string(), owner: z.enum(["organization", "user"]),
      operations: z.array(z.string()), repositories: z.array(z.string()), resource: z.string().optional() })),
  })),
  /** One run of this installation, or null. */
  "session.append": operation(running, z.strictObject({ runId, entry: sessionEntry }), z.object({id:z.string()})),
  "session.read": operation(memberPhases, z.strictObject({runId}), workflowSession),
  "workflow.read": operation(memberPhases, z.strictObject({ id }), z.object({
    run: runSummary,
    inputs: jsonObject,
    outputs: z.record(z.string(), z.object({ value: json, complete: z.boolean() })),
    readiness: z.object({ run: z.string(), steps: z.record(z.string(), z.string()) }),
    attempts: z.array(z.object({ id, nodeId: id, state: z.string(), createdAt: z.number(), updatedAt: z.number(), expiresAt: z.number().optional(), failure: z.string().optional(),
      /** The retained session archive of a failed attempt, as a run artifact reference. */
      sessionArtifact: z.object({ id: z.uuid(), runId: z.uuid() }).optional(),
      /** The workspace's latest reported progress; only for the run's creator. */
      progress: jsonObject.optional() })),
  }).nullable()),
  /** Start an approved workflow with a caller-chosen id. Replaying identical inputs succeeds; any other conflict is an error. Editors only. */
  /** Start this app's registered task using the existing durable dispatch outbox. */
  "task.start": operation(["interactive", "operator"], z.strictObject({task:id,id:runId,inputs:jsonObject}), z.object({id:runId,task:id,created:z.boolean()})),
  "workflow.start": operation(running, z.strictObject({ workflow: id, id: runId, inputs: jsonObject }),
    z.object({ id, workflow: id, created: z.boolean() })),
  /** Running runs of this installation with the requested input slots, from one slot query. */
  "workflow.active": operation(running, z.strictObject({ slots: z.array(slot).min(1).max(8), workflows: z.array(id).max(16).optional() }),
    z.array(z.object({ id, workflowId: id, inputs: jsonObject }))),
  /** A bounded, newest-first view of this installation's run activity. Apps
   * choose workflow ids and input slots needed to label their own work; tenant
   * and installation scope always come from trusted dispatch. */
  "workflow.activity": operation(memberPhases, z.strictObject({
    slots: z.array(slot).max(8).default([]),
    workflows: z.array(id).min(1).max(16).optional(),
    statuses: z.array(z.enum(["running", "complete", "failed"])).min(1).max(3).default(["running", "complete", "failed"]),
    limit: z.number().int().min(1).max(20).default(10),
    /** Also return each run's completed step ids, so an app can tell how far it got. */
    steps: z.boolean().default(false),
    /** Keyset cursor: only runs ordered after this one (updatedAt desc, id desc). */
    before: z.strictObject({ updatedAt: z.number().int(), id }).optional(),
  }), z.object({ total: z.number().int().nonnegative(), items: z.array(workflowActivity) })),
  /** Queued connector deliveries for this installation's subscriptions. */
  "workflow.pending": operation(unattended, z.strictObject({}), z.array(z.object({ id, subscriptionId: id }))),
  /** Installation-scoped run lookup by input values. App policy supplies slots and selectors; SQL stays in the host. */
  "workflow.references": operation(memberPhases, z.strictObject({
    selectors: z.array(z.strictObject({ slot, key: selectorPath, subject: selectorPath, label: selectorPath })).min(1).max(8),
    key: z.string().max(256),
    subjects: z.array(z.union([z.string().max(128), z.number().int()])).max(300),
    workflows: z.array(id).min(1).max(16),
    limitPerSubject: z.number().int().min(1).max(10).default(3),
  }), z.array(z.object({ id, key: json, subject: json, label: json, status: z.string(), updatedAt: z.number() }))),
  /** Fill an app-collected output: a connector output of a step with no actor,
   * on a run of this installation. The host validates the value against the
   * slot's schema, records the scope's user and derives the run's status. Editors only. */
  "workflow.collect": operation(running, z.strictObject({
    runId: id,
    slot: z.string().max(256).regex(/^[a-z][a-z0-9-]*\.outputs\.[A-Za-z][A-Za-z0-9-]*$/),
    value: json,
    complete: z.boolean().default(true),
  }), z.object({ run: z.string(), steps: z.record(z.string(), z.string()) })),
  /** Run one operation on a connection resource, as the scope's member. The
   * host derives access on every call: the installation's manifest must declare
   * `connector.<provider>.<operation>`; the connection must be active, where the
   * installation is, and the organization's own or the member's own; the member
   * must currently belong; and the connector checks the provider's own coverage
   * of `resource`. It lends any connection credential to that one call and
   * returns only the provider result: untrusted text the app must escape or
   * frame. Tenant and installation come from the scope. In `schedule`, only the
   * schedule's own connection and resource. An operation its connector marks
   * member-initiated (a write such as `gmail.drafts.create`) runs only in
   * `interactive` with the member's own request; every other phase gets 403. */
  "connector.execute": operation(running, z.strictObject({
    connectionId: id,
    resource: z.string().min(1).max(1024),
    operation: z.string().min(1).max(128).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/),
    input: json.default({}),
  }), json),
  /** One structured model answer on the platform's inference path, for a
   * running run of this installation, metered to that run like any workflow
   * agent step (the run owner's provider, or the platform's). The app owns
   * `instructions` and the result `schema` (a JSON Schema object); `data` is
   * passed to the model as untrusted data, never as instructions. The host
   * validates the answer against `schema`. Calls naming a session checkpoint retain private inference evidence.
   * Naming `step` applies that step's declared `inference` settings, which win
   * over any the app passes; a setting neither gives is the platform default
   * (1,500 output tokens, a 60 s timeout, the provider's reasoning). */
  "inference.generate": operation(running, z.strictObject({
    runId: runId,
    step: slug.optional(),
    checkpointId: z.string().max(128).optional(),
    instructions: z.string().min(1).max(64000),
    data: json,
    schema: jsonObject,
    ...StepInference.shape,
  }), z.object({ output: json })),
  /** Save this installation's schedule for one of its approved workflows, as
   * the scope's member (the run owner). One per workflow: saving again changes
   * it. A schedule naming `connectionId` and `resource` may use only that
   * connection, and pauses when its owner can no longer use it; it is removed
   * with the installation or the connection. Editors only. */
  "schedule.save": operation(["operator", "interactive"], z.strictObject({
    workflow: id,
    /** Five-field cron, at least six hours apart; the workflow's own schedule trigger when omitted. */
    cron: z.string().min(1).max(100).optional(),
    timezone: z.string().min(1).max(64).default("UTC"),
    inputs: jsonObject.default({}),
    connectionId: id.optional(),
    resource: z.string().min(1).max(1024).optional(),
    enabled: z.boolean().default(true),
  }).refine((input) => !input.connectionId === !input.resource, "Name a connection with its resource"), installationSchedule),
  /** This installation's schedules. */
  schedules: operation(["operator", "interactive", "schedule"], z.strictObject({}), z.array(installationSchedule)),
  /** The member's own routines and their 20 newest runs, on a user's own
   * installation with `routines.manage`. Routines are personal schedules saved
   * on the main site, not this installation's own (see `schedules`); runs are
   * every personal run the member started, any workflow or app. */
  "routines.list": operation(["operator", "interactive", "schedule"], z.strictObject({}), z.object({ routines: z.array(memberRoutine), runs: z.array(memberRun) })),
  /** Turn a task on as one of the member's routines, as the main site's "Turn on" does: a
   * recurring task on its cadence ("Weekdays at 8am"), whose first run starts now. */
  "routines.create": operation(["operator", "interactive"], z.strictObject({ ...routineTask.shape, timezone: z.string().min(1).max(64).optional() }),
    z.object({ routine: memberRoutine, runId: id })),
  /** Pause or resume one of the member's routines, or rewrite a recurring task's task and
   * cadence (`task`). Resuming never starts the occurrences it missed. */
  "routines.update": operation(["operator", "interactive"], z.strictObject({ id, enabled: z.boolean().optional(), task: routineTask.optional() })
    .refine((input) => input.enabled !== undefined || input.task, "Change enabled or task"), memberRoutine),
  /** Run one platform document as the member, as graph_query (kind query, identifiers
   * included) or graph_mutate does at scope and app "platform"; answers its `data`. With
   * `platform.documents`; an organization's installation is kept to that organization. */
  "platform.document": operation(["operator", "interactive"], z.strictObject({
    document: z.string().regex(/^[A-Z][A-Za-z]{1,63}$/), kind: z.enum(["query", "mutation"]).default("query"), variables: jsonObject.default({}),
  }), json),
  /** The operator's current declaration of one gateway target configured for this
   * organization installation (`agent-tasks.dispatch`). Never its endpoint or credential. */
  "agent-task.inspect": operation(["operator", ...agentTasks], z.strictObject(agentTarget),
    z.object({ revision: z.string(), model: z.string(), profileDigest: z.string() })),
  /** Send one ordinary A2A task to a target of this installation, returning
   * immediately with the resident's task ID; never waits for the model. The
   * gateway's message ID is derived from the target, revision, `correlationId`
   * and exact `prompt`, so resending them after a lost answer names the same
   * task. Organization and installation come from the scope.
   * Refusals: 409 the gateway does not configure this target at this revision
   * (nothing was sent); 403 the host denied the scope before any contact;
   * 502/503 the outcome is unknown. */
  "agent-task.send": operation(agentTasks, z.strictObject({ ...agentTarget, correlationId: z.uuid(), prompt: z.string().min(1).max(agentTaskPromptBytes) }),
    z.object({ taskId: z.string(), state: agentTaskState.optional() })),
  /** The current state of one task this installation sent under `correlationId`. */
  "agent-task.status": operation(agentTasks, agentTaskRef, z.object({ state: agentTaskState, result: z.object({ text: z.string().max(16384), truncated: z.boolean() }).optional() })),
  /** Request cancellation; an already terminal task keeps its state (`canceled: false`). */
  "agent-task.cancel": operation(agentTasks, agentTaskRef, z.object({ state: agentTaskState, canceled: z.boolean() })),
  /** Enable, change or disable one platform-scheduled invocation of this
   * installation's own `invocation` phase (`invocations.schedule`), as the
   * scope's editor. Occurrences run as the invocation's service principal,
   * never as that editor. Editors only. */
  "invocation.save": operation(["operator", "interactive"], z.strictObject({
    name: invocationName,
    /** Installation-owned maintenance survives changes to the enabling editor. */
    owner: z.enum(["member", "installation"]).optional(),
    /** At least the platform tick's 15 minutes; at most a week. */
    intervalMinutes: z.number().int().min(15).max(7 * 24 * 60).default(15),
    enabled: z.boolean(),
  }), appInvocation),
  /** This installation's invocations. */
  invocations: operation(["operator", "interactive", "invocation"], z.strictObject({}), z.array(appInvocation)),
  /** The verified resident a delegation names, and which installations it may
   * read work from: each one its grant reaches whose `work.list` a read-only
   * call may run (`agent-work.discover`). A listing failure fails the call. `delegation` is the operator's opaque resident
   * grant ID; the grant must name this installation. Editors only outside an
   * invocation. Listing grants nothing. */
  "agent-work.providers": operation(agentWork, z.strictObject({ delegation: workDelegation }), z.object({
    /** `resident:<identity-installation>:<resident-id>`, freshly verified. */
    principalId: z.string(),
    providers: z.array(z.object({ installationId: id, organizationId: id.optional(), permitted: z.boolean(), context: z.boolean().optional() })),
    blocked: z.array(z.object({ organizationId: id, reason: z.string() })).optional(),
  })),
  /** One installation's `work.list` answer, called as the delegated resident
   * as a read-only call: the provider runs a form that changes nothing, or
   * refuses. The action is fixed: no other action, and no input, can be named. */
  "agent-work.list": operation(agentWork, z.strictObject({ delegation: workDelegation, installationId: id }),
    z.object({ principalId: z.string(), result: json })),
  /** Read only the factual context for an assigned work item as the verified resident. */
  "agent-work.context": operation(agentWork, workContextInput.extend({ delegation: workDelegation, installationId: id }),
    z.object({ principalId: z.string(), result: workContextResult })),
  /** Verified connector inbox metadata for a run; never the provider payload or lease. */
  "connector.receipts": operation(memberPhases, z.strictObject({ runId: id }),
    z.array(z.object({ deliveryId: z.string(), provider: z.string(), receivedAt: z.number(), status: z.string() }))),
  /** The repository a binding is approved for. */
  "repository.read": operation(memberPhases, z.strictObject(repositoryTarget), z.object({
    name: z.string(), path: z.string(), repositoryId: z.number(), installationId: z.number().int().positive(),
    /** The GitHub App the platform acts as: its comments, check runs and reviews carry this id. */
    appId: z.number().int().positive(),
  })),
  /** A provider API request confined to the bound repository. Writes only in `finalize`.
   * GraphQL only where the binding grants it for the current phase: read-only,
   * except that a `finalize` grant also admits mutations with the binding's token.
   * With `connectionId` instead, editors read the repositories the organization
   * enabled on its GitHub connection, in `operator` and `interactive`, when this
   * package's manifest declares GitHub operations. GETs under an enabled
   * repository and read-only GraphQL. */
  "repository.request": operation(memberPhases, z.strictObject({
    ...repositoryTarget,
    connectionId: id.optional(),
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).default("GET"),
    path: z.string().min(1).max(2048),
    body: json.optional(),
  }).refine((input) => !(input.bindingId && input.connectionId), "Name a binding or a connection, not both"), json),
  /** A workspace gateway operation the binding declares for the current phase. Run and attempt ids come from the scope. */
  "workspace.control": operation(memberPhases, z.strictObject({
    ...repositoryTarget,
    operation: id,
    reviewer: id.optional(),
    candidate: z.strictObject({ number: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/) }).optional(),
    verdict: z.enum(["approved", "changes-requested"]).optional(),
    summary: z.string().max(65_536).optional(),
    url: z.url().max(2048).optional(),
    headSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  }), json),
  /** Approve a workspace executor binding for this installation's active package,
   * or return the enabled one with the same workflow, actor, target and context.
   * The host sets the workload identity policy. Operator configuration only. */
  "binding.approve": operation(["operator"], z.strictObject({
    workflowId: id,
    actor: id,
    label: z.string().min(1).max(256),
    workspace: jsonObject,
    context: jsonObject,
  }), z.object({ id, revision: id, reused: z.boolean() })),
  /** Save the workflow subscription of an organization connection resource; one
   * per installation, connection and resource. Its events start the workflow as
   * the scope's member while they remain an editor. Operator configuration only. */
  "subscription.save": operation(["operator"], z.strictObject({
    connectionId: id,
    resource: z.string().min(1).max(1024),
    workflowId: id,
    inputs: jsonObject,
    enabled: z.boolean().default(true),
  }), z.object({ id })),
  /** Publish a bounded artifact for the scope's run. Storage is host-owned. */
  "artifacts.publish": operation(["publish"], z.strictObject({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}\.png$/),
    contentType: z.literal("image/png"),
    base64: z.base64().max(700_000),
    revision: z.string().max(128).optional(),
  }), publishedArtifact),
  /** Artifacts published for a run of this installation. */
  "artifacts.published": operation(memberPhases, z.strictObject({ runId: id }), z.array(publishedArtifact)),
  /** Metadata of named run artifacts of a run of this installation the caller may
   * read; unknown or removed ids are omitted, so apps can show them as missing. */
  "artifacts.describe": operation(memberPhases, z.strictObject({ runId: id, ids: z.array(z.uuid()).min(1).max(50) }), z.array(z.object({
    id, runId: id, state: z.string(), expiresAt: z.number(), contentType: z.string(), filename: z.string(),
  }))),
} as const;

/** Every operation an app may call: the workflow host's own, plus the per-domain
 * maps owned by their modules (`./threads`, `./platform-records`). */
export const operations = { ...coreOperations, ...threadOperations, ...platformRecordOperations } as const;

export type WorkflowOperations = typeof operations;
export type WorkflowOperationName = keyof WorkflowOperations;
export type OperationInput<K extends WorkflowOperationName> = z.input<WorkflowOperations[K]["input"]>;
export type OperationOutput<K extends WorkflowOperationName> = z.output<WorkflowOperations[K]["output"]>;
/** Operations callable in phase `P`. */
export type PhaseOperation<P extends WorkflowPhase> = {
  [K in WorkflowOperationName]: P extends WorkflowOperations[K]["phases"][number] ? K : never;
}[WorkflowOperationName];

export function operationAllowed(name: string, current: WorkflowPhase): name is WorkflowOperationName {
  return Object.hasOwn(operations, name) &&
    (operations[name as WorkflowOperationName].phases as readonly WorkflowPhase[]).includes(current);
}

/** The RPC result envelope; a thrown error never crosses the boundary. */
export type WorkflowHostResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; message: string };
/** What dispatch props carry: an RPC stub on Workers, an in-process object on Node. */
export type WorkflowHostStub = { call(operation: string, input: unknown): Promise<WorkflowHostResult> };

/** Request-scoped host capability, typed for the operations of phase `P`. */
export interface WorkflowHost<P extends WorkflowPhase = WorkflowPhase> {
  call<K extends PhaseOperation<P>>(operation: K, input: OperationInput<K>): Promise<OperationOutput<K>>;
}

type PropsSource = { props?: unknown } | { cfContext?: { props?: unknown } } | undefined | null;
function hostStub(source: PropsSource): WorkflowHostStub | undefined {
  const holder = source && "cfContext" in source ? source.cfContext : source;
  const props = holder && "props" in holder ? holder.props : undefined;
  const stub = (props as { workflowHost?: unknown } | undefined)?.workflowHost;
  return stub && typeof (stub as WorkflowHostStub).call === "function" ? (stub as WorkflowHostStub) : undefined;
}

/** The host for this dispatch, from a Worker `ctx` or Astro `locals`. Identity
 * headers alone never produce one: without trusted props this throws 503. */
export function workflowHost<P extends WorkflowPhase = WorkflowPhase>(source: PropsSource): WorkflowHost<P> {
  const stub = hostStub(source);
  if (!stub) throw new Response("Workflow host unavailable", { status: 503 });
  return {
    async call(name, input) {
      const result = await stub.call(name, input);
      if (!result.ok) throw new Response(result.message, { status: result.status });
      return operations[name].output.parse(result.value) as never;
    },
  };
}

/** A phase request body, as the platform dispatches it to {@link workflowHostPath}. */
export const phaseRequest = z.strictObject({ phase, input: jsonObject });
export type PhaseInput = z.infer<typeof jsonObject>;
/** Generic task invocation in an installation's interactive workflow-host phase. */
export const taskInvocation = z.strictObject({ runId, task: id, inputs: jsonObject });
/** The node attempt a `prepare` or `finalize` dispatch is about. */
const node = z.object({ runId: id, nodeId: id, attemptId: runId });
/** `event` input: a verified connector delivery for one of this installation's
 * subscriptions. The host has reserved `runId`; starting a run for this
 * delivery means `workflow.start` with exactly that id. */
export const eventInput = z.object({
  runId,
  deliveryId: id,
  subscription: z.object({ id, workflowId: id, inputs: jsonObject }),
  /** The run input slot the workflow's trigger maps the event payload to. */
  trigger: z.object({ input: z.string().max(256) }),
  event: z.object({ type: z.string(), resource: z.string(), subject: z.string().optional(), payload: json }),
});
/** `event` result. Declining is an explicit answer, recorded on the delivery. */
export const eventResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("started") }),
  z.object({ outcome: z.literal("declined"), reason: z.string().min(1).max(512) }),
]);
/** `schedule` input: an occurrence of one of this installation's schedules,
 * run for the member who saved it. The host has reserved `runId`; starting a
 * run means `workflow.start` with exactly that id. */
export const scheduleInput = z.object({
  runId,
  scheduledFor: z.number().int(),
  schedule: z.object({ id, workflowId: id, inputs: jsonObject, connectionId: id.nullable(), resource: z.string().nullable() }),
});
/** `schedule` result: the reserved run started, an earlier waiting run of the
 * schedule's workflow resumed, or nothing to do (recorded on the schedule). */
export const scheduleResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("started") }),
  z.object({ outcome: z.literal("resumed"), runId: id }),
  z.object({ outcome: z.literal("declined"), reason: z.string().min(1).max(512) }),
]);
/** `invocation` input: one occurrence of an installation's enabled invocation.
 * The scope acts for no member: only operations naming `invocation` are callable. */
export const invocationInput = z.object({
  invocation: z.object({ id, name: invocationName }),
  scheduledFor: z.number().int(),
});
/** `invocation` result, recorded on the invocation. */
export const invocationResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("completed"), summary: z.string().max(512).optional() }),
  z.object({ outcome: z.literal("declined"), reason: z.string().min(1).max(512) }),
]);
/** A read-only preview the node's agent may load, pinned to one commit of the
 * bound repository. The host checks the commit is in that repository; the
 * workspace gateway serves nothing else, and only while the preview reports it. */
export const previewGrant = z.strictObject({ url: z.url().max(2048), revision: z.string().regex(/^[a-f0-9]{40}$/) });
/** `prepare` input: a node attempt about to be dispatched to a workspace. */
export const prepareInput = z.object({
  node,
  /** The node's slot inputs, resolved from the run. */
  inputs: jsonObject,
  /** The node's declared output schemas. */
  outputs: jsonObject,
  /** App-owned data from the approved binding target. */
  settings: jsonObject,
});
/** `prepare` result: run an agent session in a workspace, or coordinate without
 * one (the node is then finalized directly on the next dispatch). */
export const prepareResult = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("coordinator") }),
  z.object({
    mode: z.literal("agent"),
    /** The workspace node kind; `validate` runs `checks` (required) instead of an agent. */
    role: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    checks: z.array(z.strictObject({
      name: id,
      commands: z.array(z.array(z.string().min(1).max(1024)).min(1).max(64)).min(1).max(32),
    })).max(32).optional(),
    /** App guidance appended to the agent prompt. */
    guidance: z.array(z.string().min(1).max(4096)).max(16).optional(),
    preview: previewGrant.optional(),
  }),
]);
/** `finalize` input: the node's work is done and its attempt is leased and claimed. */
export const finalizeInput = z.object({
  node,
  inputs: jsonObject,
  /** What the workspace produced, by declared output name; empty for a coordinator. */
  outputs: jsonObject,
  coordinator: z.boolean(),
  /** The retained session archive and any output recovery, for the app to cite. */
  session: z.object({ artifact: json.optional(), outputRecovery: json.optional() }),
  settings: jsonObject,
});
/** `finalize` result: the node outputs the host completes the attempt with. */
export const finalizeResult = z.object({ outputs: jsonObject });

export type PhaseHandler<P extends WorkflowPhase> = (input: PhaseInput, host: WorkflowHost<P>) => Promise<PhaseInput>;
/** App-owned workflow policy. A phase the app does not implement answers 404. */
export type WorkflowPhaseHandlers = { [P in WorkflowPhase]?: PhaseHandler<P> };

/** Serve {@link workflowHostPath}: validate the phase request, require trusted
 * host props and run the app's handler for that phase. */
export function workflowPhaseHandler(handlers: WorkflowPhaseHandlers) {
  return async (request: Request, source: PropsSource): Promise<Response> => {
    try {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const host = workflowHost(source);
      const { phase, input } = await readJSON(request, phaseRequest, 1024 * 1024);
      const handler = handlers[phase] as PhaseHandler<WorkflowPhase> | undefined;
      if (!handler) return new Response("Workflow phase not implemented", { status: 404 });
      // Validate exactly what is sent: serialization drops undefined fields.
      const body = JSON.stringify(await handler(input, host)) ?? "null";
      jsonObject.parse(JSON.parse(body));
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    } catch (error) {
      if (error instanceof Response) return error;
      if (error instanceof z.ZodError) return new Response("Invalid workflow phase result", { status: 502 });
      throw error;
    }
  };
}

import { z } from "zod";
import { hostOperation } from "./host-operation";

/**
 * Platform-record host operations: typed, scope-checked reads and member
 * writes of records the platform keeps (the member's profile, personal
 * projects, Google and GitHub connections, the organization's context and
 * workflow drafting rules). An app reaches them only through its host scope
 * and the `platform.records` capability; it never sees SQL, tokens or
 * credentials. Each call acts for the scope's member, with their own
 * connections; a resident, invocation or setup scope is refused.
 *
 * Platform projects are the member's own project records (`/p/<id>` in the
 * workspace), distinct from any app's domain projects.
 */
export const platformRecordsCapability = "platform.records";

const id = z.string().min(1).max(128);
const json = z.json();
const member = ["interactive"] as const;

// ---- Member profile -------------------------------------------------------

const confidence = z.enum(["low", "medium", "high"]);
/** The member's work profile, inferred from their mail by the email-profile workflow. */
export const workProfile = z.object({
  whoTheyAre: z.object({ summary: z.string().min(1).max(800), organization: z.string().max(200).nullable() }),
  suspectedRole: z.object({ title: z.string().max(200).nullable(), confidence, reasoning: z.string().max(800) }),
  writingStyle: z.object({ summary: z.string().max(800), traits: z.array(z.string().max(100)).max(5), confidence }),
  suggestedWorkflows: z.array(z.object({
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(800),
    trigger: z.string().min(1).max(300),
    steps: z.array(z.string().min(1).max(300)).max(5),
    whyUseful: z.string().min(1).max(800),
  })).max(3),
  // Profiles saved before apps were suggested have none.
  suggestedApps: z.array(z.object({
    name: z.string().min(1).max(80),
    goal: z.string().min(1).max(300),
    audience: z.enum(["self", "customers", "team"]),
    persona: z.object({ name: z.string().min(1).max(80), need: z.string().min(1).max(300) }),
    successMetrics: z.array(z.object({
      name: z.string().min(1).max(120),
      target: z.string().min(1).max(120),
      /** In words, what is counted over the record. */
      query: z.string().min(1).max(300).optional(),
    })).min(1).max(3),
    whyUseful: z.string().min(1).max(500),
    /** What the agent saw that justifies the app (absent on older suggestions). */
    source: z.object({
      provider: z.enum(["gmail", "google-calendar"]),
      observation: z.string().min(1).max(200),
      volume: z.string().min(1).max(80).nullable(),
    }).optional(),
    /** The thing the app tracks and the few fields it keeps. */
    record: z.object({ name: z.string().min(1).max(60), fields: z.array(z.string().min(1).max(60)).min(1).max(8) }).optional(),
    /** The connector operation ids the app will need. */
    operations: z.array(z.string().min(1).max(80)).optional(),
  // An app that breaks a bound drops the suggestions, never the whole profile.
  })).max(3).catch([]),
});
export type WorkProfile = z.infer<typeof workProfile>;

/** The work profile card's state: the saved profile, still being produced, or failed. */
export const workProfileStatus = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), profile: workProfile }).strict(),
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("failed"), error: z.string().max(300) }).strict(),
]);

export const GOAL_HORIZONS = ["month", "quarter", "year"] as const;
export const MAX_GOALS = 10;
export const PROFILE_FIELD_CHARACTERS = 800;
const setValue = z.object({ value: z.string().min(1).max(PROFILE_FIELD_CHARACTERS), setAt: z.number() });
export const profileGoal = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(200),
  horizon: z.enum(GOAL_HORIZONS).nullable(),
  done: z.boolean(),
  /** The member's routines (personal schedule ids) that work toward this goal. */
  routineIds: z.array(z.string().max(64)).max(20),
});
export type ProfileGoal = z.infer<typeof profileGoal>;
/** What the member set on /profile themselves. */
export const memberProfile = z.object({
  about: z.object({ summary: setValue.optional(), organization: setValue.optional(), role: setValue.optional(), writingStyle: setValue.optional() }),
  goals: z.array(profileGoal).max(MAX_GOALS),
});
export type MemberProfile = z.infer<typeof memberProfile>;

const edit = z.string().max(PROFILE_FIELD_CHARACTERS).nullable().optional();
/** A goal as a patch sends it: a new one has no id; leaving out `routineIds` keeps the stored links. */
const goalInput = profileGoal.extend({
  id: profileGoal.shape.id.optional(),
  text: z.string().trim().min(1).max(200),
  horizon: profileGoal.shape.horizon.default(null),
  done: z.boolean().default(false),
  routineIds: profileGoal.shape.routineIds.optional(),
}).strict();
/** What a patch may change: a field's value (empty or null resets it to what was inferred) and the goal list, in order. */
export const profilePatch = z.object({
  about: z.object({ summary: edit, organization: edit, role: edit, writingStyle: edit }).strict().optional(),
  goals: z.array(goalInput).max(MAX_GOALS).optional(),
}).strict();
export type ProfilePatch = z.infer<typeof profilePatch>;

// ---- Platform projects ----------------------------------------------------

export const PROJECT_REPOSITORIES = 20;
export const repositoryName = z.string().max(140)
  .regex(/^[a-zA-Z0-9-]{1,39}\/[a-zA-Z0-9_.-]{1,100}$/)
  .refine((value) => ![".", ".."].includes(value.split("/")[1]))
  .transform((value) => value.toLowerCase());
/** The member's own platform project. */
export const platformProject = z.object({
  id: z.uuid(),
  name: z.string().max(200),
  instructions: z.string().max(20_000),
  repositories: z.array(z.string().max(140)).max(PROJECT_REPOSITORIES),
  updatedAt: z.number(),
});
export type PlatformProject = z.infer<typeof platformProject>;

// ---- Connections ----------------------------------------------------------

export const googleService = z.enum(["gmail", "google-calendar"]);
export const googleConnectionSummary = z.object({
  id,
  provider: googleService,
  status: z.string().max(40),
  email: z.string().max(320).nullable(),
  /** The grant allows drafts or events. */
  writes: z.boolean(),
});
const mailRow = z.object({
  id: z.string().max(256), threadId: z.string().max(256).nullable(), from: z.string().max(400), subject: z.string().max(1000),
  date: z.string().max(400), receivedAt: z.string().max(64), snippet: z.string().max(1000),
});
const eventRow = z.object({
  id: z.string().max(1024), title: z.string().max(1000), start: z.string().max(64), end: z.string().max(64),
  location: z.string().max(1000), recurring: z.boolean(), organizer: z.string().max(400), attendees: z.number().int().nonnegative(),
});
const rfc3339 = z.iso.datetime({ offset: true });
const githubTool = z.object({ name: z.string().max(128), description: z.string().max(4000), inputSchema: z.record(z.string(), json) });
const repositories = z.array(repositoryName).max(PROJECT_REPOSITORIES);

// ---- Workflow drafts ------------------------------------------------------

export const PROPOSE_WORKFLOW = "propose_workflow";
// A string keeps the Responses strict tool schema small. The host validates
// the complete graph before returning a card.
export const workflowProposalInput = z.object({ job: z.string().min(2).max(20_000) }).strict();
const cardStep = z.object({
  id: z.string(), title: z.string(), actor: z.enum(["agent", "owner", "connector"]),
  who: z.string(), description: z.string(), after: z.array(z.string()),
  reads: z.array(z.string()), produces: z.array(z.string()), needs: z.array(z.string()),
  review: z.boolean(), effect: z.boolean(), status: z.string().optional(),
});
export const workflowProposalOutput = z.discriminatedUnion("valid", [
  z.object({ valid: z.literal(true), card: z.object({
    id: z.string(), title: z.string(), benefit: z.string(), schedule: z.string(),
    steps: z.array(cardStep),
    connections: z.array(z.object({ label: z.string(), state: z.enum(["connected", "needed"]) })),
    state: z.object({ kind: z.enum(["draft", "needs-connection"]), label: z.string() }),
    issues: z.array(z.string()).length(0),
  }) }),
  z.object({ valid: z.literal(false), errors: z.array(z.string()).min(1) }),
]);

// ---- Operations -----------------------------------------------------------

export const platformRecordOperations = {
  /** The member's own profile: what they set, and what was inferred from their mail. */
  "profile.read": hostOperation(member, z.strictObject({}), z.object({ member: memberProfile, work: workProfile.nullable() })),
  /**
   * Apply a patch to the member's own layer (as /profile does); returns the saved layer.
   * With `expected` (the `member` a `profile.read` returned) the write happens only if the
   * profile is still that one, else 409: concurrent edits read again instead of overwriting.
   */
  "profile.update": hostOperation(member, z.strictObject({ patch: profilePatch, expected: memberProfile.optional() }), z.object({ member: memberProfile })),
  /** The work profile card: the saved profile or the latest email-profile run's state. */
  "profile.work": hostOperation(member, z.strictObject({}), workProfileStatus),
  /** The owning organization's context for this member, or null on a personal installation. */
  "organization.context": hostOperation(member, z.strictObject({}), z.object({
    organization: z.object({ id, name: z.string(), slug: z.string().optional(), instructions: z.string(), operational: z.boolean() }).nullable(),
  })),
  /** The member's own platform projects, most recently updated first. */
  "projects.list": hostOperation(member, z.strictObject({}), z.object({ projects: z.array(platformProject) })),
  "projects.get": hostOperation(member, z.strictObject({ id: z.uuid() }), platformProject.nullable()),
  /** Which Google services this platform can connect, and the member's connections in this owner scope. */
  "connectors.google": hostOperation(member, z.strictObject({}), z.object({
    available: z.array(googleService), connections: z.array(googleConnectionSummary),
  })),
  /** Search or list the member's Gmail (newest first), framed as data. */
  "connectors.google.messages": hostOperation(member, z.strictObject({
    connectionId: id,
    query: z.string().min(1).max(300).optional(),
    days: z.number().int().min(1).max(365).optional(),
    limit: z.number().int().min(1).max(20).default(10),
    /** Leave out promotions, social and other low-signal categories. */
    excludeQuiet: z.boolean().optional(),
  }), z.object({ messages: z.array(mailRow) })),
  /** One Gmail message: headers and clipped text. Written by other people. */
  "connectors.google.message": hostOperation(member, z.strictObject({
    connectionId: id, messageId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  }), z.object({
    id: z.string(), date: z.string(), from: z.string(), subject: z.string(), snippet: z.string(),
    to: z.string(), labels: z.array(z.string()), text: z.string(),
  })),
  /** Events on the member's primary calendar in start order. */
  "connectors.google.events": hostOperation(member, z.strictObject({
    connectionId: id, timeMin: rfc3339.optional(), timeMax: rfc3339.optional(),
    query: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(25).default(25),
  }), z.object({ events: z.array(eventRow) })),
  /** GitHub's hosted MCP tools over the named repositories the member may push to. */
  "connectors.github.tools": hostOperation(member, z.strictObject({ repositories }), z.object({
    repositories: z.array(z.string()), tools: z.array(githubTool),
  })),
  /** Run one GitHub MCP tool; the resource must be one of `repositories`. Commits to a default branch are refused. */
  "connectors.github.call": hostOperation(member, z.strictObject({
    repositories, name: z.string().min(1).max(128), input: z.record(z.string(), json),
  }), z.object({ output: json })),
  /** Workflow drafting rules: the setup contract's guidance and the member's granted connector categories. */
  "workflows.proposal": hostOperation(member, z.strictObject({}), z.object({
    guidance: z.string(), categories: z.array(z.string()),
  })),
  /** Validate a model-authored workflow draft against the platform's workflow rules. */
  "workflows.validate": hostOperation(member, workflowProposalInput, workflowProposalOutput),
  /** The current release's app catalog, with no tenant records, and the guidance a reply recommending apps follows. */
  "catalog.apps": hostOperation(member, z.strictObject({}), z.object({
    apps: z.array(z.object({ slug: z.string(), name: z.string(), description: z.string(), access: z.string() })),
    prompt: z.string(),
  })),
  /** Whether the inference this owner's conversations reply with takes the effort picker's levels (as threads resolve it). */
  "inference.effort": hostOperation(member, z.strictObject({}), z.object({ effort: z.boolean() })),
  /** The query and mutation documents the conversation owner's apps ship and its Wiki's trusted documents, each
   * with its user story: the owner's organization, else the member's own apps and Wiki (as graph_documents lists them). */
  "graph.documents": hostOperation(member, z.strictObject({}), json),
  /** Run one of those query documents by name or hash as the member through this app, read only, within
   * 48 KiB: `{ data, errors?, extensions? }` (as graph_graphql answers a document). */
  "graph.graphql": hostOperation(member, z.strictObject({ document: z.string().min(1).max(200), variables: z.record(z.string(), json).optional() }), json),
  /** Run one of those mutation documents on one of its installations as the member through this app, as
   * graph_mutate does: variables within 256 KiB, the app checks write access, `{ data, errors? }` within 48 KiB.
   * The Wiki's documents only stage a batch; a member commits it on the Wiki's Changes page. */
  "graph.mutate": hostOperation(member, z.strictObject({
    document: z.string().min(1).max(200), installationId: z.string().min(1).max(200), variables: z.record(z.string(), json).optional(),
  }), json),
} as const;

// ---- Onboarding cards -----------------------------------------------------
//
// UI tool cards a guest's homepage conversation can contain. The platform's
// guest onboarding writes them into its transcript and the signup claim hands
// that transcript to the member's Chat, which renders and continues them, so
// both sides share these contracts.

const connectService = googleService;
export const CONNECT_SERVICES = "connect_services";
export const connectServicesInput = z.object({
  /** Which services to offer; both when omitted. */
  services: z.array(connectService).optional(),
}).strict();
export const connectServicesOutput = z.object({
  services: z.array(connectService).refine((services) => new Set(services).size === services.length, "Services must be unique"),
  /** The address the visitor wrote themselves; suggested at sign-up and Google consent. */
  email: z.email().optional(),
}).strict();

/** The member's message when they choose Not now on the connect card. */
export const CONNECT_LATER = "Not now, I'll connect an account later.";
export const isConnectLater = (text: string | null | undefined) =>
  text?.trim() === CONNECT_LATER || text?.trim() === "Not now, I'll connect Gmail and Google Calendar later.";

/** One recurring task the assistant offers as an answer to its question. */
const proposedTask = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  title: z.string().min(1).max(120),
  /** How often it runs, in words: "Every Monday", "Daily at 8am", "The day before each event". */
  schedule: z.string().min(1).max(80),
  /** What in their inbox or calendar suggests it, in a sentence. */
  evidence: z.string().min(1).max(240),
  /** What the routine does each run, when it is known (a profile suggestion's own description). */
  description: z.string().min(1).max(800).optional(),
  steps: z.array(z.string().min(1).max(300)).max(5).optional(),
}).strict();
const proposedApp = z.object({ name: z.string().min(1).max(80), reason: z.string().min(1).max(180) }).strict();
export const PROPOSE_TASKS = "propose_tasks";
export const proposeTasksInput = z.object({ tasks: z.array(proposedTask).min(1).max(6), apps: z.array(proposedApp).max(4).optional() })
  .strict()
  .refine(({ tasks }) => new Set(tasks.map((t) => t.id)).size === tasks.length, "Task ids must be unique");
export const proposeTasksOutput = proposeTasksInput;
/** propose_tasks' input when the server fills the choices from the profile. */
export const profileTasksInput = z.object({}).strict();

/** A finished onboarding card call, as a guest transcript stores it. */
const toolCallId = z.string().min(1).max(200);
export const onboardingToolCall = z.discriminatedUnion("name", [
  z.object({ name: z.literal(CONNECT_SERVICES), toolCallId, input: connectServicesInput, output: connectServicesOutput }).strict(),
  z.object({ name: z.literal(PROPOSE_TASKS), toolCallId, input: z.union([proposeTasksInput, profileTasksInput]), output: proposeTasksOutput }).strict(),
  z.object({ name: z.literal(PROPOSE_WORKFLOW), toolCallId, input: workflowProposalInput, output: workflowProposalOutput }).strict(),
]);
export type OnboardingToolCall = z.infer<typeof onboardingToolCall>;

/** The `tool-<name>` UI part the AI SDK client renders for a finished call. */
export const toolCallPart = (call: { name: string; toolCallId: string; input: unknown; output: unknown }) => ({
  type: `tool-${call.name}` as const,
  toolCallId: call.toolCallId,
  state: "output-available" as const,
  input: call.input,
  output: call.output,
});

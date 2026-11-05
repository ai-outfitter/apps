import { z } from "zod";
import { readJSON, respond } from "./server";

/** Shared threads: the public contract between apps and the platform's thread
 * service. The platform stores conversational threads, runs replies and owns
 * privacy; apps publish thread types and answer context, tool and history
 * callbacks through trusted dispatch. Apps never touch the primary database. */

/** A package may call `threads.*` host operations and the browser routes under {@link threadRoutesBase}. */
export const threadUseCapability = "threads.use";
/** A package publishes thread types and answers the provider callbacks at {@link threadProviderPath}. */
export const threadProviderCapability = "threads.provide";
/** Reserved provider callback prefix; platform ingress refuses it for every method. */
export const threadProviderPath = "/api/internal/threads/v1/";
/** Platform browser routes, on an installation host or the main host. */
export const threadRoutesBase = "/api/platform/threads";

const json = z.json();
type Json = z.infer<typeof json>;
const id = z.string().min(1).max(128);
const boundedJSON = (bytes: number) => json.refine((value) => JSON.stringify(value).length <= bytes, `At most ${bytes} bytes`);

export const threadTypeName = z.string().max(128).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);
export const threadVisibility = z.enum(["private", "organization"]);
export type ThreadVisibility = z.infer<typeof threadVisibility>;
export const threadOwner = z.object({ kind: z.enum(["organization", "user"]), id });
export type ThreadOwner = z.infer<typeof threadOwner>;
export const threadActor = z.object({
  kind: z.enum(["member", "oauth-client", "app", "platform", "resident", "model"]),
  id: z.string().min(1).max(300),
  label: z.string().max(200).optional(),
});
export type ThreadActor = z.infer<typeof threadActor>;

const storedRef = z.strictObject({ id: z.uuid() });
const providerRef = z.strictObject({ installationId: id, type: threadTypeName, sourceId: z.string().min(1).max(256) });
/** A stored conversational thread, or a provider-owned history thread. */
export const threadRef = z.union([storedRef, providerRef]);
export type ThreadRef = z.infer<typeof threadRef>;
export const isStoredRef = (ref: ThreadRef): ref is { id: string } => "id" in ref;
/** A stable string key for a ref: the id, or `p:<installation>:<type>:<source>`. */
export function threadRefKey(ref: ThreadRef) {
  return isStoredRef(ref) ? ref.id : `p:${ref.installationId}:${ref.type}:${encodeURIComponent(ref.sourceId)}`;
}
export function parseThreadRefKey(key: string): ThreadRef | undefined {
  const match = /^p:([^:]+):([^:]+):(.+)$/.exec(key);
  const candidate = match ? { installationId: match[1], type: match[2], sourceId: safeDecode(match[3]) } : { id: key };
  const parsed = threadRef.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
function safeDecode(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export const threadContext = z.strictObject({ type: threadTypeName, id: z.string().min(1).max(256), label: z.string().max(200).optional() });
export type ThreadContext = z.infer<typeof threadContext>;

export const threadStatus = z.enum(["active", "archived"]);
export const thread = z.object({
  ref: threadRef,
  id: z.string(),
  owner: threadOwner,
  installationId: id.nullable(),
  createdBy: id.nullable(),
  visibility: threadVisibility,
  type: threadTypeName,
  typeVersion: z.number().int().positive(),
  title: z.string().max(200),
  status: threadStatus,
  context: threadContext.nullable(),
  parent: z.object({ id: z.string(), entryId: z.string().nullable() }).nullable(),
  pinned: z.boolean(),
  working: z.boolean(),
  readOnly: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Thread = z.infer<typeof thread>;

const partName = threadTypeName;
export const knownThreadPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(200_000) }),
  z.object({ type: z.literal("file"), attachmentId: z.uuid(), filename: z.string().max(255), mediaType: z.string().max(100), url: z.string().max(2048) }),
  z.object({ type: z.literal("tool-call"), callId: z.string().max(200), name: z.string().max(128), input: json }),
  z.object({ type: z.literal("tool-result"), callId: z.string().max(200), name: z.string().max(128), output: json, error: z.string().max(4000).optional() }),
  z.object({ type: z.literal("proposal"), installationId: id, proposalId: z.string().min(1).max(200), action: z.string().max(128).optional(),
    label: z.string().max(200).optional(), status: z.string().max(64).optional(), revision: z.number().int().optional() }),
  z.object({ type: z.literal("workflow-input"), name: z.string().max(256), value: json }),
  z.object({ type: z.literal("workflow-output"), name: z.string().max(256), value: json, complete: z.boolean() }),
  z.object({ type: z.literal("attempt"), attemptId: z.string().max(200), nodeId: z.string().max(200), state: z.string().max(64),
    failure: z.string().max(4096).optional(), createdAt: z.number().optional(), updatedAt: z.number().optional() }),
  z.object({ type: z.literal("status"), status: z.string().max(64), label: z.string().max(200).optional(), detail: z.string().max(4096).optional() }),
  z.object({ type: z.literal("artifact"), name: z.string().max(256), artifactId: z.string().max(200).optional(), contentType: z.string().max(100).optional(),
    url: z.string().max(2048).optional(), availability: z.enum(["available", "missing", "expired", "incomplete"]) }),
  z.object({ type: z.literal("thread-link"), ref: threadRef, relation: z.enum(["child", "session", "parent", "related"]), title: z.string().max(200).optional() }),
  z.object({ type: z.literal("data"), name: z.string().max(128), version: z.number().int().positive().optional(), data: json }),
]);
export type ThreadPart = z.infer<typeof knownThreadPart>;
/** A part as written by an app or provider: a known part, or a namespaced extension. */
export const threadPart = knownThreadPart.refine((part) => part.type !== "data" || partName.safeParse(part.name).success || part.name === "unknown",
  "Extension parts need a namespaced name");
/** Typed parts with a generic structured fallback: unknown or invalid shapes are kept as `data` parts named `unknown`, never dropped. */
export function parseThreadParts(raw: unknown): ThreadPart[] {
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return values.map((value) => {
    const parsed = knownThreadPart.safeParse(value);
    if (parsed.success) return parsed.data;
    const data = json.safeParse(value);
    return { type: "data" as const, name: "unknown", data: data.success ? data.data : null };
  });
}
/** The plain text of an entry's text parts. */
export const partsText = (parts: readonly ThreadPart[]) =>
  parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

export const entryRole = z.enum(["user", "assistant", "note", "event"]);
export const entryStatus = z.enum(["complete", "partial", "error", "aborted"]);
export const threadEntry = z.object({
  id: z.string().min(1).max(256),
  thread: threadRef,
  role: entryRole,
  parts: z.array(knownThreadPart),
  status: entryStatus,
  submissionId: z.string().nullable(),
  sourceKey: z.string().max(256).nullable(),
  attribution: z.object({ actor: threadActor, origin: threadActor, userId: z.string().nullable(), installationId: z.string().nullable() }),
  metadata: json.nullable(),
  createdAt: z.number(),
  recordedAt: z.number().nullable(),
});
export type ThreadEntry = z.infer<typeof threadEntry>;
export const threadEntryPage = z.object({ entries: z.array(threadEntry), before: z.string().nullable(), after: z.string().nullable() });
export type ThreadEntryPage = z.infer<typeof threadEntryPage>;

export const threadOperationNames = ["list", "get", "entries", "create", "append", "send", "cancel", "upload", "delete"] as const;
export type ThreadOperation = (typeof threadOperationNames)[number];
/** Operations a provider-owned history type may declare. */
export const historyOperations = ["list", "get", "entries"] as const satisfies readonly ThreadOperation[];
/** Bounds for published schemas: one schema, and all of a type's schemas together (JSON text). */
export const threadSchemaBytes = 16 * 1024;
export const threadSchemasBytes = 64 * 1024;
/**
 * An app-owned, namespaced and versioned JSON Schema a provider publishes with
 * its thread type: the shape of its typed `context`, of a `data` part name it
 * emits, or of entry/submission `metadata`. Descriptive only: the platform
 * keeps its generic validation (and the structured fallback for unknown or
 * non-conforming parts); consumers may use a schema to label or check what
 * they render. Schemas travel only in `threads.types`; there is no registry.
 */
export const threadSchemaDescriptor = z.strictObject({
  name: threadTypeName,
  version: z.number().int().positive(),
  kind: z.enum(["context", "part", "metadata"]),
  title: z.string().min(1).max(200).optional(),
  schema: z.record(z.string(), json).refine((value) => JSON.stringify(value).length <= threadSchemaBytes, `A schema is at most ${threadSchemaBytes} bytes`),
});
export type ThreadSchemaDescriptor = z.infer<typeof threadSchemaDescriptor>;
/** The published schema for a `data` part (exact version, else the newest), if any. */
export function partSchema(schemas: readonly ThreadSchemaDescriptor[] | undefined, name: string, version?: number) {
  const named = (schemas ?? []).filter((schema) => schema.kind === "part" && schema.name === name);
  return named.find((schema) => schema.version === version) ?? named.sort((a, b) => b.version - a.version)[0];
}

export const threadTypeDescriptor = z.strictObject({
  type: threadTypeName,
  version: z.number().int().positive().default(1),
  label: z.string().min(1).max(200),
  kind: z.enum(["conversation", "history"]),
  operations: z.array(z.enum(threadOperationNames)).min(1).max(threadOperationNames.length),
  contexts: z.array(threadTypeName).max(32).optional(),
  parts: z.array(threadTypeName).max(64).optional(),
  notify: z.array(z.enum(["deleted"])).max(1).optional(),
  /** Optional app-owned schemas of this type's contexts, `data` parts and metadata. */
  schemas: z.array(threadSchemaDescriptor).max(32).optional(),
}).refine((value) => value.kind === "conversation" || value.operations.every((operation) => (historyOperations as readonly string[]).includes(operation)),
  "History types are read-only: list, get and entries only")
  .refine((value) => JSON.stringify(value.schemas ?? []).length <= threadSchemasBytes, `A type's schemas are at most ${threadSchemasBytes} bytes`)
  .refine((value) => new Set((value.schemas ?? []).map((schema) => `${schema.kind}:${schema.name}:${schema.version}`)).size === (value.schemas ?? []).length,
    "Each schema name and version is published once per kind")
  .refine((value) => (value.schemas ?? []).every((schema) =>
    (schema.kind !== "part" || !value.parts || value.parts.includes(schema.name)) &&
    (schema.kind !== "context" || !value.contexts || value.contexts.includes(schema.name))),
  "A part or context schema names a part or context the type declares");
export type ThreadTypeDescriptor = z.infer<typeof threadTypeDescriptor>;

export const submissionState = z.object({
  threadId: z.string(),
  submissionId: z.string(),
  state: z.enum(["running", "completed", "partial", "failed", "aborted", "interrupted"]),
  replyEntryIds: z.array(z.string()),
});
export type SubmissionState = z.infer<typeof submissionState>;

export const threadImageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const threadAttachment = z.object({ id: z.uuid(), filename: z.string().max(255), mediaType: z.enum(threadImageTypes), url: z.string() });
export type ThreadAttachment = z.infer<typeof threadAttachment>;
export const threadAttachmentPath = (threadId: string, attachmentId: string) =>
  `${threadRoutesBase}/${threadId}/attachments/${attachmentId}`;
/** A run artifact cited by a provider-owned history thread, read with the source installation's authority. */
export const threadArtifactPath = (ref: ThreadRef, artifactId: string, download = false) =>
  `${threadRoutesBase}/${encodeURIComponent(threadRefKey(ref))}/artifacts/${artifactId}${download ? "?download=1" : ""}`;
/**
 * Rebase a platform thread path (`/api/platform/threads/...`, as entries and
 * uploads report it) onto the page's canonical mount, keeping the acting
 * installation: on `/o/<org>/<app>` or `/apps/<id>/` pages a root-relative
 * path would name the wrong owner.
 */
export function mountThreadPath(path: string, base = threadRoutesBase, installationId?: string) {
  if (!path.startsWith(threadRoutesBase)) return path;
  const url = new URL(base + path.slice(threadRoutesBase.length), "https://mount.invalid");
  if (installationId && !url.searchParams.has("installation")) url.searchParams.set("installation", installationId);
  return `${url.pathname}${url.search}`;
}

/** Submission metadata limit (JSON text): room for a page's opted-in draft. */
export const submissionMetadataBytes = 128 * 1024;
/** Provider `prepare` context limit (JSON text), sent to the model as untrusted data. */
export const prepareContextBytes = 256 * 1024;

// Inputs shared by host operations and browser routes.
export const effort = z.enum(["low", "high", "max"]);
export const listThreadsInput = z.strictObject({
  type: threadTypeName.optional(),
  types: z.array(threadTypeName).min(1).max(16).optional(),
  context: threadContext.pick({ type: true, id: true }).optional(),
  parentId: z.uuid().optional(),
  visibility: threadVisibility.optional(),
  /** Only threads the caller created. */
  mine: z.boolean().optional(),
  /** Required for provider-owned history types: the provider installation. */
  installationId: id.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});
export const threadListResult = z.object({ threads: z.array(thread), cursor: z.string().nullable() });
export const entriesInput = z.strictObject({
  ref: threadRef,
  before: z.string().max(512).optional(),
  after: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
const seedEntry = z.strictObject({
  id: z.uuid(), role: z.enum(["user", "assistant", "note"]), text: z.string().max(64_000),
  recordedAt: z.number().int().optional(), metadata: boundedJSON(8192).optional(),
});
export const createThreadInput = z.strictObject({
  /** Caller-chosen stable id; an identical replay returns the existing thread. */
  id: z.uuid().optional(),
  type: threadTypeName,
  title: z.string().trim().max(200).default(""),
  visibility: threadVisibility.default("private"),
  context: threadContext.optional(),
  parent: z.strictObject({ id: z.uuid(), entryId: z.string().min(1).max(256).optional() }).optional(),
  /** Seed history, e.g. a claimed guest conversation. */
  entries: z.array(seedEntry).max(50).optional(),
});
/** A read-only restore of one visible conversation in an explicit app context. */
export const threadSnapshotInput = z.strictObject({
  type: threadTypeName,
  context: threadContext,
  preferred: z.uuid().optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

export const updateThreadInput = z.strictObject({
  threadId: z.uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  status: threadStatus.optional(),
});
export const appendEntryInput = z.strictObject({
  threadId: z.uuid(),
  /** Idempotency key, unique within the thread: an identical replay returns the existing entry. */
  sourceKey: z.string().min(1).max(200),
  role: z.enum(["note", "event", "assistant"]),
  parts: z.array(threadPart).min(1).max(32),
  metadata: boundedJSON(8192).optional(),
  recordedAt: z.number().int().optional(),
});
export const sendInput = z.strictObject({
  threadId: z.uuid(),
  submissionId: z.uuid(),
  text: z.string().max(12_000).default(""),
  attachments: z.array(z.uuid()).max(4).default([]),
  effort: effort.optional(),
  /** Bounded app metadata kept on the user entry and passed to `prepare` (e.g. a page focus claim or an opted-in draft); part of the payload hash. */
  metadata: boundedJSON(submissionMetadataBytes).optional(),
  /** Run again after a failed, aborted, interrupted or partial reply. */
  retry: z.boolean().optional(),
}).refine((value) => Boolean(value.text.trim() || value.attachments.length), "A message or attachment is required");
export type SendInput = z.input<typeof sendInput>;
/** Browser body for `POST /api/platform/threads/{id}/submissions`. */
export const submissionBody = z.strictObject({
  submissionId: z.uuid(),
  text: z.string().max(12_000).default(""),
  attachments: z.array(z.uuid()).max(4).default([]),
  effort: effort.optional(),
  metadata: boundedJSON(submissionMetadataBytes).optional(),
  retry: z.boolean().optional(),
});

const running = ["event", "operator", "interactive", "schedule"] as const;
const op = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) => ({ phases: running, input, output });
/** Host operations for threads (require `threads.use`). Merged into the workflow-host `operations` map. */
export const threadOperations = {
  "threads.types": op(z.strictObject({}), z.array(threadTypeDescriptor.and(z.object({ installationId: id })))),
  "threads.list": op(listThreadsInput, threadListResult),
  "threads.get": op(z.strictObject({ ref: threadRef }), thread.nullable()),
  "threads.entries": op(entriesInput, threadEntryPage),
  "threads.create": op(createThreadInput, thread),
  "threads.update": op(updateThreadInput, thread),
  "threads.append": op(appendEntryInput, threadEntry),
  "threads.send": op(sendInput, submissionState),
  "threads.submission": op(z.strictObject({ threadId: z.uuid(), submissionId: z.uuid() }), submissionState.nullable()),
  "threads.cancel": op(z.strictObject({ threadId: z.uuid(), submissionId: z.uuid().optional() }), z.object({ canceled: z.boolean() })),
  "threads.delete": op(z.strictObject({ threadId: z.uuid() }), z.object({ deleted: z.literal(true), detachedChildren: z.number().int().nonnegative() })),
} as const;

// Provider callbacks: the platform calls these on the providing app.
const providerItem = thread.omit({ id: true, ref: true, owner: true, installationId: true, readOnly: true, working: true, pinned: true })
  .extend({ sourceId: z.string().min(1).max(256), createdBy: id.nullable().default(null), parent: thread.shape.parent.default(null),
    context: threadContext.nullable().default(null), status: threadStatus.default("active"), typeVersion: z.number().int().positive().default(1),
    visibility: threadVisibility.default("organization") });
const providerEntry = threadEntry.omit({ thread: true }).extend({
  status: entryStatus.default("complete"), submissionId: z.string().nullable().default(null), sourceKey: z.string().max(256).nullable().default(null),
  metadata: json.nullable().default(null), recordedAt: z.number().nullable().default(null),
  parts: z.array(z.unknown()).max(256).transform(parseThreadParts),
});
export const toolDescriptor = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  description: z.string().max(2000),
  inputSchema: z.record(z.string(), json),
  /** The reply ends after this tool runs (UI cards). */
  stop: z.boolean().optional(),
  /** `false`: the result streams to the browser and serves the model in this reply only;
   * the saved entry keeps `{ omitted: true }` and later history never replays the call. */
  store: z.literal(false).optional(),
});
/** What a saved entry keeps of a `store: false` tool result. */
export const omittedToolOutput = { omitted: true } as const;
export const providerCallbacks = {
  types: { input: z.strictObject({}), output: z.array(threadTypeDescriptor).max(32) },
  prepare: {
    input: z.object({ thread, submissionId: z.string(), entry: threadEntry, retry: z.boolean(), effort: effort.optional() }),
    output: z.strictObject({
      instructions: z.string().max(32_000).default(""),
      context: boundedJSON(prepareContextBytes).optional(),
      history: z.union([
        z.strictObject({ limit: z.number().int().min(0).max(200) }),
        z.strictObject({ entries: z.array(z.string().max(256)).max(200) }),
      ]).optional(),
      tools: z.array(toolDescriptor).max(64).default([]),
      maxSteps: z.number().int().min(1).max(16).default(4),
      /** Default 4096. */
      maxOutputTokens: z.number().int().min(1).max(8000).optional(),
    }),
  },
  tool: {
    input: z.object({ thread, submissionId: z.string(), call: z.object({ id: z.string(), name: z.string(), input: json }),
      /** Tool calls already made earlier in this submission, in order. */
      calls: z.array(z.object({ name: z.string(), callId: z.string() })).default([]) }),
    output: z.strictObject({ output: json, parts: z.array(threadPart).max(16).optional(), stop: z.boolean().optional() }),
  },
  finish: {
    input: z.object({ thread, submissionId: z.string(), state: submissionState, entryIds: z.array(z.string()) }),
    output: z.unknown(),
  },
  deleted: {
    input: z.object({ threadId: z.string(), type: threadTypeName, context: threadContext.nullable() }),
    output: z.unknown(),
  },
  list: {
    input: z.object({ type: threadTypeName, context: threadContext.pick({ type: true, id: true }).optional(), limit: z.number().int(), cursor: z.string().optional() }),
    output: z.object({ threads: z.array(providerItem).max(100), cursor: z.string().max(512).nullable().default(null) }),
  },
  get: {
    input: z.object({ type: threadTypeName, sourceId: z.string() }),
    output: providerItem.nullable(),
  },
  entries: {
    input: z.object({ type: threadTypeName, sourceId: z.string(), before: z.string().optional(), after: z.string().optional(), limit: z.number().int() }),
    output: z.object({ entries: z.array(providerEntry).max(200), before: z.string().max(512).nullable().default(null), after: z.string().max(512).nullable().default(null) }),
  },
} as const;
export type ProviderCallback = keyof typeof providerCallbacks;
export type ProviderInput<K extends ProviderCallback> = z.output<(typeof providerCallbacks)[K]["input"]>;
export type ProviderOutput<K extends ProviderCallback> = z.input<(typeof providerCallbacks)[K]["output"]>;
export type ThreadProviderHandlers = {
  types(request: Request): Promise<ProviderOutput<"types">> | ProviderOutput<"types">;
} & { [K in Exclude<ProviderCallback, "types">]?: (input: ProviderInput<K>, request: Request) => Promise<ProviderOutput<K>> };

/** Serve {@link threadProviderPath}: mount behind the app's identity middleware at
 * `/api/internal/threads/v1/[operation]`. Only platform dispatch reaches it. */
export function threadProvider(handlers: ThreadProviderHandlers) {
  return async (request: Request, operation: string): Promise<Response> => {
    try {
      return await respond(async () => {
        if (request.method !== "POST" || !Object.hasOwn(providerCallbacks, operation))
          throw new Response("Not found", { status: 404 });
        const name = operation as ProviderCallback;
        const input = providerCallbacks[name].input.parse(await readJSON(request, z.unknown(), 1024 * 1024));
        if (name === "types") return providerCallbacks.types.output.parse(await handlers.types(request));
        const handler = handlers[name] as ((value: unknown, request: Request) => Promise<unknown>) | undefined;
        if (!handler) throw new Response("Thread callback not implemented", { status: 404 });
        return (await handler(input, request)) ?? null;
      });
    } catch (error) {
      if (error instanceof z.ZodError) return new Response("Invalid thread callback input", { status: 400 });
      throw error;
    }
  };
}

/** A deterministic UUID for app policy such as "one timeline per project": the
 * same namespace and parts always name the same thread, so concurrent first
 * opens converge on one thread through `threads.create`'s idempotent id. */
export async function stableThreadId(namespace: string, ...parts: string[]) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([namespace, ...parts]))));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Same-origin browser client for the platform thread routes. `send()` returns
 * the raw response: an AI SDK UI message stream, or JSON `{ submission }` for a
 * duplicate submission. */
export function threadClient(options: { base?: string; installationId?: string; fetch?: typeof fetch } = {}) {
  const base = options.base ?? threadRoutesBase;
  const fetcher = options.fetch ?? fetch;
  const url = (path: string, query: Record<string, string | number | undefined> = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...query, installation: options.installationId }))
      if (value !== undefined && value !== "") params.set(key, String(value));
    const search = params.toString();
    return `${base}${path}${search ? `?${search}` : ""}`;
  };
  const mount = (path: string) => mountThreadPath(path, base, options.installationId);
  async function request<T>(path: string, init: RequestInit = {}, query?: Record<string, string | number | undefined>): Promise<T> {
    const response = await fetcher(url(path, query), { credentials: "same-origin", ...init });
    if (!response.ok) throw new Error((await response.text()).slice(0, 1000) || `Request failed (${response.status})`);
    return response.json() as Promise<T>;
  }
  const body = (value: unknown, method: string): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  return {
    /** `provider` names the installation of a provider-owned history type. */
    list: (query: { type?: string; context?: { type: string; id: string }; parent?: string; cursor?: string; limit?: number; mine?: boolean; provider?: string } = {}) =>
      request<z.infer<typeof threadListResult>>("", {}, {
        type: query.type, provider: query.provider, context: query.context ? `${query.context.type}:${query.context.id}` : undefined,
        parent: query.parent, cursor: query.cursor, limit: query.limit, mine: query.mine ? 1 : undefined,
      }),
    snapshot: (input: z.input<typeof threadSnapshotInput>) =>
      request<{ thread: Thread | null; entries: ThreadEntry[]; before: string | null }>("", {}, {
        view: "snapshot", type: input.type, context: `${input.context.type}:${input.context.id}`, preferred: input.preferred, limit: input.limit,
      }).then((page) => ({ ...page, entries: page.entries.map((entry) => ({ ...entry, parts: entry.parts.map((part) =>
        (part.type === "file" || part.type === "artifact") && part.url ? { ...part, url: mount(part.url) } : part) })) })),
    get: (id: string) => request<Thread>(`/${encodeURIComponent(id)}`),
    /** Entries with file and artifact URLs rebased onto this client's mount. */
    entries: async (id: string, page: { before?: string; after?: string; limit?: number } = {}) => {
      const result = await request<ThreadEntryPage>(`/${encodeURIComponent(id)}/entries`, {}, page);
      return { ...result, entries: result.entries.map((entry) => ({ ...entry, parts: entry.parts.map((part) =>
        (part.type === "file" || part.type === "artifact") && part.url ? { ...part, url: mount(part.url) } : part) })) };
    },
    /** A platform thread path (attachment or artifact) as this page must request it. */
    url: (path: string) => mount(path),
    create: (input: z.input<typeof createThreadInput>) => request<Thread>("", body(input, "POST")),
    update: (id: string, patch: Omit<z.input<typeof updateThreadInput>, "threadId">) => request<Thread>(`/${id}`, body(patch, "PATCH")),
    remove: (id: string) => request<{ deleted: true; detachedChildren: number }>(`/${id}`, { method: "DELETE" }),
    async upload(id: string, file: File | Blob, filename = (file as File).name ?? "image"): Promise<ThreadAttachment> {
      const response = await fetcher(url(`/${id}/uploads`), {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": file.type, "X-Filename": encodeURIComponent(filename) }, body: file,
      });
      if (!response.ok) throw new Error((await response.text()).slice(0, 1000));
      const attachment = threadAttachment.parse(await response.json());
      return { ...attachment, url: mount(attachment.url) };
    },
    submissionsURL: (id: string) => url(`/${id}/submissions`),
    send: (id: string, input: z.input<typeof submissionBody>, signal?: AbortSignal) =>
      fetcher(url(`/${id}/submissions`), { ...body(input, "POST"), credentials: "same-origin", signal }),
    cancel: (id: string, submissionId: string) =>
      request<{ canceled: boolean }>(`/${id}/submissions/${submissionId}`, { method: "DELETE" }),
  };
}

export type { Json as ThreadJson };

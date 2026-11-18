import type { SQL } from "drizzle-orm";
import type { ModelDescription, Thread, ThreadActor, ThreadTypeDescriptor, ThreadContextSource } from "@ai-outfitter/app-sdk/threads";
import type { LanguageModel } from "ai";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

/**
 * Who is asking, resolved by the platform from `authenticated()` or a verified
 * workflow-host scope plus `installationOwner()`. The thread service never
 * reads sessions or memberships itself; it only applies thread predicates.
 */
export type ThreadPrincipal = {
  userId: string;
  /** The owner scope: an organization the caller currently belongs to, or null for the caller's personal scope. */
  organizationId: string | null;
  /** An authenticated member's own request (not a resident, invocation or platform setup): private threads need it. */
  memberContext: boolean;
  /** Organization owner/admin: may update or delete organization-shared threads. */
  canAdminister: boolean;
  /** The installation acting (attribution, and the provider for new threads). */
  installationId: string | null;
  actor: ThreadActor;
  origin: ThreadActor;
  /** Platform-only dispatch context (e.g. a verified resident delegation); the service never reads it. */
  dispatch?: unknown;
};

/** Drizzle async SQLite (D1 or libSQL) with atomic batches. */
// biome-ignore lint/suspicious/noExplicitAny: drivers differ only in their result types.
export type ThreadDatabase = BaseSQLiteDatabase<"async", any, any> & { batch(queries: [any, ...any[]]): Promise<any> };

export type ThreadObjects = {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<unknown>;
  get(key: string): Promise<ReadableStream | Blob | ArrayBuffer | null | undefined>;
  delete(keys: string[]): Promise<unknown>;
  presignGet(key: string, seconds: number): Promise<string>;
};

/** The provider configuration one reply uses; `pinned` is the platform's own handle, passed back to accounting unchanged. */
export type ResolvedInference = {
  model: LanguageModel;
  effort: boolean;
  pinned?: unknown;
  /** The provider accepts OpenAI's `prompt_cache_key`, so a thread's turns share one prompt cache. */
  promptCache?: boolean;
  /** How the platform names this model and its provider, for administrators' inspection. */
  describe?: ModelDescription;
};
export type ThreadInference = {
  resolve(principal: ThreadPrincipal, thread: { id: string; organizationId: string | null }): Promise<ResolvedInference>;
};

export type ThreadAccounting = {
  /** Meter exactly the configuration `resolved` (never a second lookup). */
  /** `ref.incarnation` (the thread's per-creation token) keeps a recreated thread's keys distinct. */
  start(principal: ThreadPrincipal, ref: { threadId: string; incarnation: string; submissionId: string; organizationId: string | null }, resolved: ResolvedInference): Promise<{
    observe(raw: unknown): void;
    /** `entryId`: the persisted assistant entry, or null when nothing was saved. */
    settle(outcome: "completed" | "aborted" | "error", entryId: string | null): Promise<unknown>;
  }>;
};

/** Provider dispatch: the platform wires these to app dispatch with fresh owner checks. */
export type ThreadProviders = {
  /** Same-owner, operational installations declaring `threads.provide`. */
  installations(principal: ThreadPrincipal): Promise<string[]>;
  /** One provider callback; throws a Response on refusal. */
  call(principal: ThreadPrincipal, installationId: string, operation: string, input: unknown): Promise<unknown>;
};

/**
 * The platform's own conversation types, answered in-process instead of by an installed app.
 * Their names start with `platform.`; their threads have no installation and are always private.
 */
export type PlatformProvider = {
  types: ThreadTypeDescriptor[];
  /** One provider callback (`prepare`, `tool`, `finish`), as an app's provider would answer it. */
  call(principal: ThreadPrincipal, operation: string, input: unknown): Promise<unknown>;
};

export type ThreadAdapters = {
  db: ThreadDatabase;
  objects: ThreadObjects;
  inference: ThreadInference;
  accounting: ThreadAccounting;
  providers: ThreadProviders;
  /** The platform's own conversation types (none by default). */
  platform?: PlatformProvider;
  /** Keeps work alive after the response (waitUntil on Workers). */
  retain?(work: Promise<unknown>): void;
  now?(): number;
  /**
   * Statements the platform adds to a conversation's guarded deletion batch (e.g. scrubbing
   * copies of its content kept elsewhere). Each must apply only while `when` holds, so the
   * whole deletion, these included, commits or changes nothing.
   */
  deletion?(thread: { id: string; incarnation: string }, when: SQL): unknown[];
  /** Whether this caller may inspect replies' prompts and tools (platform administrators). None by default. */
  inspector?(principal: ThreadPrincipal): Promise<boolean>;
  /** Resolve authorized, same-owner snapshots at exact revisions on every reply.
   * Content is transient data, never a transcript checkpoint or trusted instruction. */
  source?(principal: ThreadPrincipal, source: ThreadContextSource, thread: Thread): Promise<unknown>;
  /** Trusted base instructions placed before the provider's (none by default). */
  baseInstructions?: string;
  /** The platform's own agent tools, for a provider that asks for them (`platformTools` from prepare). */
  platformTools?(principal: ThreadPrincipal, thread: Thread): Promise<PlatformTools | undefined>;
};

/** Tools the platform runs itself, with the instructions that explain them. Results are never stored in the transcript. */
export type PlatformTools = {
  instructions: string;
  tools: { name: string; description: string; inputSchema: Record<string, unknown>; run(input: unknown): Promise<unknown> }[];
  /** The reply may take at least this many steps, so discovery and reads fit in one reply. */
  minSteps?: number;
};

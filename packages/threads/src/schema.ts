import { appInstallations, organization, user } from "@ai-outfitter/server/schema";
import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Shared thread storage: the platform's existing `chats`, `messages` and
 * `attachments` tables, generalized. A row of `chats` is a thread; a row of
 * `messages` is one of its entries. `src/db/schema.ts` re-exports these.
 *
 * Ownership: an organization thread has `organizationId`; a personal thread has
 * none and belongs to its creator (`userId`). `visibility` is `private` (the
 * creator only) or `organization` (every member); personal threads are always
 * private. `installationId` is provenance, never access.
 */
export const chats = sqliteTable(
  "chats",
  {
    id: text().primaryKey(),
    /** The creator; a personal thread's owner. An organization thread outlives its
     * creator's account (set null); account deletion removes personal threads first. */
    userId: text().references(() => user.id, { onDelete: "set null" }),
    title: text().notNull(),
    organizationId: text().references(() => organization.id, { onDelete: "restrict" }),
    /** The installation the thread was created through (provenance only). */
    installationId: text().references(() => appInstallations.id, { onDelete: "set null" }),
    visibility: text({ enum: ["private", "organization"] }).notNull().default("private"),
    /** Namespaced thread type, e.g. `chat.conversation`, declared by a provider app. */
    type: text().notNull().default("chat.conversation"),
    typeVersion: integer().notNull().default(1),
    status: text({ enum: ["active", "archived"] }).notNull().default("active"),
    /** Optional typed entity context; many threads may share one. */
    contextType: text(),
    contextId: text(),
    contextLabel: text(),
    /** A child thread's parent and originating entry; deleting either detaches the child. */
    parentId: text().references((): AnySQLiteColumn => chats.id, { onDelete: "set null" }),
    parentEntryId: text().references((): AnySQLiteColumn => messages.id, { onDelete: "set null" }),
    pinned: integer({ mode: "boolean" }).notNull().default(false),
    // Workspace sessions and workflow runs keep their existing rows and archives.
    workspace: integer({ mode: "boolean" }).notNull().default(false),
    workflow: text(),
    // Prompt text appended to every reply's system prompt, set by trusted
    // server code that started the thread (never the browser or an app).
    prompt: text(),
    createdAt: integer().notNull().default(0),
    updatedAt: integer().notNull(),
    /** Hash of the creation request (type, owner, visibility, context, parent, seed
     * entries, provenance): an identical replay returns the thread, any other conflicts. */
    creationHash: text(),
    /** The provider asked to acknowledge deletion first (recorded at creation, so an
     * unavailable provider can never let a deletion skip it). */
    notifyDeleted: integer({ mode: "boolean" }).notNull().default(false),
    /** Reply lease: one reply per thread at a time. */
    leaseUntil: integer().notNull().default(0),
    /** The submission holding the lease. */
    leaseToken: text(),
    // A random token per creation: a thread recreated under the same id (even within the
    // same millisecond) is a different incarnation for guards and accounting keys.
    incarnation: text(),
    // Opaque per-acquisition fence: every reply write and release must present it.
    leaseNonce: text(),
    /** Incremented on every acquire; fences a worker whose lease was taken over. */
    leaseGeneration: integer().notNull().default(0),
    /** A cancellation requested for the running submission. */
    cancelToken: text(),
  },
  (t) => [
    index("chats_user_updated_idx").on(t.userId, t.updatedAt),
    index("chats_org_visibility_idx").on(t.organizationId, t.visibility, t.updatedAt),
    index("chats_context_idx").on(t.contextType, t.contextId, t.updatedAt),
    index("chats_parent_idx").on(t.parentId),
    index("chats_parent_entry_idx").on(t.parentEntryId),
    check("chats_personal_private", sql`${t.visibility} = 'private' OR ${t.organizationId} IS NOT NULL`),
    // A personal thread always has its owner: deleting the account must remove it first.
    check("chats_personal_owner", sql`${t.organizationId} IS NOT NULL OR ${t.userId} IS NOT NULL`),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text().primaryKey(),
    chatId: text()
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text({ enum: ["user", "assistant", "note", "event"] }).notNull(),
    /** Plain text of the entry's text parts (summaries, profile extraction). */
    content: text().notNull(),
    /** JSON ThreadPart[] (`@ai-outfitter/app-sdk/threads`). */
    parts: text(),
    status: text({ enum: ["complete", "partial", "error", "aborted"] }).notNull().default("complete"),
    /** A user entry's own submission id, or the submission an assistant entry answers. */
    submissionId: text(),
    /** A user entry's payload hash: exact replays and conflicting reuse are told apart. */
    payloadHash: text(),
    /** App-appended entries' idempotency key, unique per thread. */
    sourceKey: text(),
    /** JSON ThreadActor: the immediate actor and the origin of the chain. */
    actor: text(),
    origin: text(),
    actorUserId: text(),
    installationId: text(),
    metadata: text(),
    /** The source's own timestamp when it recorded one; never fabricated. */
    recordedAt: integer(),
    createdAt: integer().notNull(),
  },
  (t) => [
    index("messages_chat_time_idx").on(t.chatId, t.createdAt),
    index("messages_submission_idx").on(t.chatId, t.submissionId),
    uniqueIndex("messages_source_key_idx").on(t.chatId, t.sourceKey).where(sql`"sourceKey" IS NOT NULL`),
  ],
);

/**
 * A thread's images. Bytes live in private object storage at
 * `chats/<chatId>/<id>`. `uploading` while the platform writes the object,
 * `pending` until sent with an entry, `sent`, `expired` once an unsent upload
 * is swept, `deleting` as a tombstone until the object is removed. No foreign
 * keys: tombstones outlive their thread until object cleanup succeeds.
 */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text().primaryKey(),
    /** The uploader; an organization thread's images outlive the uploader's account. */
    userId: text().references(() => user.id, { onDelete: "set null" }),
    chatId: text().notNull(),
    messageId: text(),
    mediaType: text().notNull(),
    filename: text().notNull(),
    size: integer().notNull(),
    state: text({ enum: ["uploading", "pending", "sent", "expired", "deleting"] }).notNull(),
    createdAt: integer().notNull(),
    checkedAt: integer().notNull().default(0),
  },
  (t) => [
    index("attachments_chat_idx").on(t.chatId, t.state),
    index("attachments_user_idx").on(t.userId),
    index("attachments_sweep_idx").on(t.state, t.checkedAt),
  ],
);

export type ThreadRow = typeof chats.$inferSelect;
export type EntryRow = typeof messages.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;

import {
  appendEntryInput,
  createThreadInput,
  entriesInput,
  isStoredRef,
  listThreadsInput,
  partsText,
  providerCallbacks,
  type SubmissionState,
  type Thread,
  type ThreadEntry,
  type ThreadEntryPage,
  type ThreadRef,
  type ThreadTypeDescriptor,
  threadTypeDescriptor,
  threadSnapshotInput,
  updateThreadInput,
} from "@ai-outfitter/app-sdk/threads";
import { and, asc, desc, eq, exists, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { threadAttachments } from "./attachments";
import { replies } from "./reply";
import { administers, admitted, entryColumns, incarnationOf, platformOwned, readOnlyThread, conflict, decodeCursor, encodeCursor, forbidden, notFound, sha256, toEntry, toThread, visibleTo } from "./rows";
import { type AttachmentRow, attachments, chats, type EntryRow, messages, type ThreadRow } from "./schema";
import type { ThreadAdapters, ThreadPrincipal } from "./types";
import { appInstallations } from "@ai-outfitter/server/schema";

type Descriptor = ThreadTypeDescriptor & { installationId: string };
const readOnly = () => new Response("Read-only thread type", { status: 405 });

/** The generic thread service. Built per request; every operation re-applies the principal's visibility. */
export function createThreadService(adapters: ThreadAdapters) {
  const { db } = adapters;
  const now = () => adapters.now?.() ?? Date.now();
  const files = threadAttachments(adapters);
  const described = new Map<string, Promise<ThreadTypeDescriptor[] | undefined>>();

  async function installations(principal: ThreadPrincipal) {
    return new Set(await adapters.providers.installations(principal));
  }

  /** One installation's descriptors, or undefined when its provider could not answer. */
  function discover(principal: ThreadPrincipal, installationId: string) {
    const key = `${principal.userId}:${principal.organizationId}:${installationId}`;
    let found = described.get(key);
    if (!found) {
      found = adapters.providers.call(principal, installationId, "types", {})
        .then((value) => z.array(threadTypeDescriptor).max(32).parse(value))
        .catch((error) => {
          // The reason is what tells a redeploy, a timeout and a broken provider apart.
          const reason = error instanceof Response ? error.text().then((text) => text.slice(0, 300), () => "") : Promise.resolve(String(error).slice(0, 300));
          void reason.then((detail) => console.warn("thread provider types unavailable", { installationId, status: error instanceof Response ? error.status : undefined, detail }));
          return undefined;
        });
      described.set(key, found);
    }
    return found;
  }
  /** Listing and reads treat an unavailable provider as publishing nothing. */
  const describe = async (principal: ThreadPrincipal, installationId: string) => (await discover(principal, installationId)) ?? [];

  async function types(principal: ThreadPrincipal): Promise<Descriptor[]> {
    const ids = [...(await installations(principal))];
    const all = await Promise.all(ids.map(async (installationId) =>
      (await describe(principal, installationId)).map((descriptor) => ({ ...descriptor, installationId }))));
    return all.flat();
  }

  /** The descriptor `installationId` publishes for `type`, if it is a current same-owner provider. */
  /** Undefined for no such current provider or type; null when a current provider did not answer. */
  async function descriptor(principal: ThreadPrincipal, installationId: string | null, type: string) {
    if (!installationId || !(await installations(principal)).has(installationId)) return undefined;
    const described = await discover(principal, installationId);
    if (!described) return null;
    const found = described.find((candidate) => candidate.type === type);
    return found ? { ...found, installationId } : undefined;
  }

  async function visibleRow(principal: ThreadPrincipal, id: string) {
    if (!z.uuid().safeParse(id).success) return undefined;
    const [row] = await db.select().from(chats).where(and(eq(chats.id, id), visibleTo(principal)));
    return row as ThreadRow | undefined;
  }
  async function requireRow(principal: ThreadPrincipal, id: string) {
    const row = await visibleRow(principal, id);
    if (!row) throw notFound();
    return row;
  }

  // Provider-owned history: read through the provider, never copied.
  async function historyProvider(principal: ThreadPrincipal, installationId: string | undefined, type: string, operation: "list" | "get" | "entries") {
    const found = await descriptor(principal, installationId ?? null, type);
    if (found?.kind !== "history" || !found.operations.includes(operation)) throw notFound();
    return found;
  }
  function historyThread(principal: ThreadPrincipal, installationId: string, type: string, item: z.output<typeof providerCallbacks.list.output>["threads"][number]): Thread {
    const ref = { installationId, type, sourceId: item.sourceId };
    const { sourceId: _, ...rest } = item;
    return {
      ...rest,
      ref,
      id: `p:${installationId}:${type}:${encodeURIComponent(item.sourceId)}`,
      type,
      owner: principal.organizationId ? { kind: "organization", id: principal.organizationId } : { kind: "user", id: principal.userId },
      installationId,
      readOnly: true,
      working: false,
      pinned: false,
    };
  }

  async function snapshot(principal: ThreadPrincipal, raw: unknown) {
    const input = threadSnapshotInput.parse(raw);
    if (!principal.installationId) throw notFound();
    const [row] = await db.select().from(chats).where(and(
      visibleTo(principal), eq(chats.installationId, principal.installationId), eq(chats.type, input.type),
      eq(chats.contextType, input.context.type), eq(chats.contextId, input.context.id),
      or(and(eq(chats.visibility, "private"), eq(chats.userId, principal.userId)), input.preferred ? eq(chats.id, input.preferred) : undefined),
      isNull(chats.workflow), eq(chats.workspace, false), isNull(chats.parentId),
    )).orderBy(...(input.preferred ? [desc(sql`case when ${chats.id} = ${input.preferred} then 1 else 0 end`)] : []), desc(chats.updatedAt), desc(chats.id)).limit(1);
    if (!row) return { thread: null, entries: [], before: null };
    const page = await entries(principal, { ref: { id: row.id }, limit: input.limit });
    return { thread: toThread(row, now()), entries: page.entries, before: page.before };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each optional filter adds one condition.
  async function list(principal: ThreadPrincipal, raw: unknown) {
    const input = listThreadsInput.parse(raw);
    const type = input.type ?? (input.types?.length === 1 ? input.types[0] : undefined);
    if (input.installationId && type) {
      const found = await descriptor(principal, input.installationId, type);
      if (found?.kind === "history") {
        await historyProvider(principal, input.installationId, type, "list");
        const result = providerCallbacks.list.output.parse(await adapters.providers.call(principal, input.installationId, "list", {
          type, ...(input.context ? { context: input.context } : {}), limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}),
        }));
        return { threads: result.threads.map((item) => historyThread(principal, input.installationId!, type, item)), cursor: result.cursor };
      }
    }
    // A type is its provider's: listing a type the acting installation declares itself
    // returns that installation's threads, so another app declaring the same name
    // cannot place threads in it. An explicit installation filters the same way.
    let origin = input.installationId;
    if (!origin && type && principal.installationId) {
      const own = await descriptor(principal, principal.installationId, type).catch(() => undefined);
      if (own?.kind === "conversation") origin = principal.installationId;
    }
    const cursor = decodeCursor(input.cursor);
    const conditions: (SQL | undefined)[] = [
      visibleTo(principal),
      origin ? eq(chats.installationId, origin) : undefined,
      input.type ? eq(chats.type, input.type) : undefined,
      input.types ? inArray(chats.type, input.types) : undefined,
      input.context ? and(eq(chats.contextType, input.context.type), eq(chats.contextId, input.context.id)) : undefined,
      input.parentId ? eq(chats.parentId, input.parentId) : undefined,
      input.visibility ? eq(chats.visibility, input.visibility) : undefined,
      input.mine ? eq(chats.userId, principal.userId) : undefined,
      cursor ? or(lt(chats.updatedAt, cursor.at), and(eq(chats.updatedAt, cursor.at), lt(chats.id, cursor.id))) : undefined,
    ];
    const rows = await db.select().from(chats).where(and(...conditions))
      .orderBy(desc(chats.updatedAt), desc(chats.id)).limit(input.limit + 1);
    const page = rows.slice(0, input.limit) as ThreadRow[];
    const last = page.at(-1);
    const at = now();
    return { threads: page.map((row) => toThread(row, at)), cursor: rows.length > input.limit && last ? encodeCursor(last.updatedAt, last.id) : null };
  }

  async function get(principal: ThreadPrincipal, ref: ThreadRef): Promise<Thread | null> {
    if (isStoredRef(ref)) {
      const row = await visibleRow(principal, ref.id);
      return row ? toThread(row, now()) : null;
    }
    try {
      await historyProvider(principal, ref.installationId, ref.type, "get");
    } catch {
      return null;
    }
    const item = providerCallbacks.get.output.parse(await adapters.providers.call(principal, ref.installationId, "get", { type: ref.type, sourceId: ref.sourceId }));
    return item && item.sourceId === ref.sourceId ? historyThread(principal, ref.installationId, ref.type, item) : null;
  }

  /** The thread incarnation the caller was authorized for, re-checked inside each read: a row
   * deleted and recreated under the same id (perhaps another member's private thread) never matches. */
  const authorizedIncarnation = (principal: ThreadPrincipal, row: ThreadRow) =>
    db.select({ id: chats.id }).from(chats).where(admitted(principal, row));

  async function storedEntries(principal: ThreadPrincipal, row: ThreadRow, query: { before?: string; after?: string; limit: number }): Promise<ThreadEntryPage> {
    const before = decodeCursor(query.before), after = decodeCursor(query.after);
    const authorized = inArray(messages.chatId, authorizedIncarnation(principal, row));
    const older = (c: { at: number; id: string }) => or(lt(messages.createdAt, c.at), and(eq(messages.createdAt, c.at), lt(messages.id, c.id)));
    const newer = (c: { at: number; id: string }) => or(gt(messages.createdAt, c.at), and(eq(messages.createdAt, c.at), gt(messages.id, c.id)));
    let rows: EntryRow[];
    let moreBefore = false, moreAfter = false;
    if (after) {
      rows = await db.select().from(messages).where(and(eq(messages.chatId, row.id), authorized, newer(after)))
        .orderBy(asc(messages.createdAt), asc(messages.id)).limit(query.limit + 1);
      moreAfter = rows.length > query.limit;
      rows = rows.slice(0, query.limit);
      moreBefore = true;
    } else {
      rows = await db.select().from(messages).where(and(eq(messages.chatId, row.id), authorized, before ? older(before) : undefined))
        .orderBy(desc(messages.createdAt), desc(messages.id)).limit(query.limit + 1);
      moreBefore = rows.length > query.limit;
      rows = rows.slice(0, query.limit).reverse();
      moreAfter = Boolean(before);
    }
    const ids = rows.map((entry) => entry.id);
    const sent = ids.length
      ? await db.select().from(attachments).where(and(eq(attachments.chatId, row.id), inArray(attachments.chatId, authorizedIncarnation(principal, row)), eq(attachments.state, "sent"), inArray(attachments.messageId, ids)))
      : [];
    const first = rows[0], last = rows.at(-1);
    return {
      entries: rows.map((entry) => toEntry(entry, sent, row.userId)),
      before: moreBefore && first ? encodeCursor(first.createdAt, first.id) : null,
      after: moreAfter && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async function entries(principal: ThreadPrincipal, raw: unknown): Promise<ThreadEntryPage> {
    const input = entriesInput.parse(raw);
    if (isStoredRef(input.ref)) return storedEntries(principal, await requireRow(principal, input.ref.id), input);
    const ref = input.ref;
    await historyProvider(principal, ref.installationId, ref.type, "entries");
    const page = providerCallbacks.entries.output.parse(await adapters.providers.call(principal, ref.installationId, "entries", {
      type: ref.type, sourceId: ref.sourceId, limit: input.limit,
      ...(input.before ? { before: input.before } : {}), ...(input.after ? { after: input.after } : {}),
    }));
    // Provider order is the timeline order; `createdAt` is an ordering key, `recordedAt` the only time.
    return { ...page, entries: page.entries.map((entry) => ({ ...entry, thread: ref })) };
  }

  /** A conversation type the acting installation provides with `operation`. */
  async function conversationType(principal: ThreadPrincipal, installationId: string | null, type: string, operation: "create" | "append" | "send") {
    const found = await descriptor(principal, installationId, type);
    if (found?.kind === "history") throw readOnly();
    // A current provider that did not answer is an outage, not a missing type.
    if (found === null)
      throw new Response("The app behind this conversation is unavailable or updating. Try again in a moment.", { status: 503 });
    if (!found || !found.operations.includes(operation)) throw new Response("Thread provider unavailable", { status: 409 });
    return found;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: inheritance, creation identity and seeds are one atomic write.
  async function create(principal: ThreadPrincipal, raw: unknown) {
    const input = createThreadInput.parse(raw);
    const provider = await conversationType(principal, principal.installationId, input.type, "create");
    const parent = input.parent ? await requireRow(principal, input.parent.id) : undefined;
    if (parent && input.parent?.entryId) {
      const [entry] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.id, input.parent.entryId), eq(messages.chatId, parent.id)));
      if (!entry) throw notFound();
    }
    // A child takes its parent's owner and visibility; personal threads are always private.
    const organizationId = parent ? parent.organizationId : principal.organizationId;
    const visibility = parent ? parent.visibility : organizationId ? input.visibility : "private";
    if (visibility === "private" && !principal.memberContext) throw forbidden("Private threads need a member's own request");
    const id = input.id ?? crypto.randomUUID();
    // The creation identity: everything the request fixed, including provenance and seed history.
    // The provider's current version is discovery state, not request input: a replay after an
    // upgrade is the same request and keeps the version stored at creation.
    const creationHash = await sha256({
      type: input.type, title: input.title, organizationId, visibility, context: input.context ?? null, parent: input.parent ?? null,
      entries: input.entries ?? [], installationId: principal.installationId, userId: principal.userId,
    });
    const at = now();
    const row: typeof chats.$inferInsert = {
      id, userId: principal.userId, organizationId, installationId: principal.installationId, visibility,
      type: input.type, typeVersion: provider.version, title: input.title.slice(0, 200), contextType: input.context?.type ?? null, contextId: input.context?.id ?? null,
      contextLabel: input.context?.label ?? null, parentId: parent?.id ?? null, parentEntryId: input.parent?.entryId ?? null,
      creationHash, notifyDeleted: Boolean(provider.notify?.includes("deleted")), createdAt: at, incarnation: crypto.randomUUID(),
      // updatedAt tracks the latest entry, so the next entry orders after every seed.
      updatedAt: at + Math.max((input.entries?.length ?? 0) - 1, 0),
    };
    const actor = JSON.stringify(principal.actor), origin = JSON.stringify(principal.origin);
    const seeds = (input.entries ?? []).map((entry, index) => ({
      id: entry.id, chatId: id, role: entry.role, content: entry.text, parts: JSON.stringify([{ type: "text", text: entry.text }]),
      // An imported entry's role is presentation; its actor is the verified caller who inserted it.
      submissionId: entry.role === "user" ? entry.id : null, actor, origin,
      actorUserId: principal.userId, installationId: principal.installationId,
      metadata: entry.metadata === undefined ? null : JSON.stringify(entry.metadata), recordedAt: entry.recordedAt ?? null, createdAt: at + index,
    } satisfies typeof messages.$inferInsert));
    try {
      await db.batch([
        db.insert(chats).values(row),
        ...(seeds.length ? [db.insert(messages).values(seeds)] : []),
      ]);
    } catch (error) {
      const [existing] = await db.select().from(chats).where(eq(chats.id, id));
      if (!existing) throw error;
      // Only the identical original request is a replay; later edits (a rename) are kept.
      if (existing.creationHash !== creationHash) throw conflict("Thread id already used for another thread");
      const visible = await visibleRow(principal, id);
      if (!visible) throw conflict("Thread id already used for another thread");
      return toThread(visible, now());
    }
    return toThread(await requireRow(principal, id), now());
  }

  async function update(principal: ThreadPrincipal, raw: unknown) {
    const input = updateThreadInput.parse(raw);
    const row = await requireRow(principal, input.threadId);
    if (platformOwned(row) && input.status !== undefined) throw readOnlyThread();
    if (!administers(principal, row)) throw forbidden();
    const patch = Object.fromEntries(Object.entries({ title: input.title, pinned: input.pinned, status: input.status })
      .filter(([, value]) => value !== undefined)) as Partial<Pick<ThreadRow, "title" | "pinned" | "status">>;
    if (Object.keys(patch).length) {
      const changed = await db.update(chats).set(patch).where(admitted(principal, row)).returning({ id: chats.id });
      if (!changed.length) throw notFound();
    }
    return toThread(await requireRow(principal, row.id), now());
  }

  /** Only the thread's own provider writes events into a conversation. */
  async function requireAppender(principal: ThreadPrincipal, row: ThreadRow) {
    if (platformOwned(row)) throw readOnlyThread();
    if (!principal.installationId || principal.installationId !== row.installationId) throw forbidden("Only the thread's provider appends entries");
    await conversationType(principal, row.installationId, row.type, "append");
  }

  async function append(principal: ThreadPrincipal, raw: unknown): Promise<ThreadEntry> {
    const input = appendEntryInput.parse(raw);
    const row = await requireRow(principal, input.threadId);
    await requireAppender(principal, row);
    const payloadHash = await sha256({ role: input.role, parts: input.parts, metadata: input.metadata ?? null, recordedAt: input.recordedAt ?? null });
    const at = Math.max(now(), row.updatedAt + 1);
    const entry: typeof messages.$inferInsert = {
      id: crypto.randomUUID(), chatId: row.id, role: input.role, content: partsText(input.parts), parts: JSON.stringify(input.parts),
      status: "complete", submissionId: null, payloadHash, sourceKey: input.sourceKey, actor: JSON.stringify(principal.actor), origin: JSON.stringify(principal.origin),
      actorUserId: principal.userId, installationId: principal.installationId,
      metadata: input.metadata === undefined ? null : JSON.stringify(input.metadata), recordedAt: input.recordedAt ?? null, createdAt: at,
    };
    // INSERT … SELECT from the admitted incarnation: a thread recreated meanwhile gets nothing.
    const inserted = await db.insert(messages).select(db.select(entryColumns(entry as EntryRow)).from(chats).where(admitted(principal, row)))
      .onConflictDoNothing().returning({ id: messages.id });
    const [stored] = await db.select().from(messages).where(and(eq(messages.chatId, row.id), eq(messages.sourceKey, input.sourceKey),
      inArray(messages.chatId, authorizedIncarnation(principal, row))));
    if (!stored) throw notFound();
    if (!inserted.length && stored.payloadHash !== payloadHash) throw conflict("Source key already used for another entry");
    if (inserted.length) await db.update(chats).set({ updatedAt: at }).where(admitted(principal, row));
    return toEntry(stored, [], row.userId);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: deletion checks, acknowledgement and the guarded batch are one ordered protocol.
  async function remove(principal: ThreadPrincipal, threadId: string) {
    const row = await requireRow(principal, threadId);
    // Deleting a conversation never deletes a session's or workflow's records or evidence.
    if (platformOwned(row)) throw readOnlyThread();
    if (!administers(principal, row)) throw forbidden();
    // A running reply could still call the provider's tools after its domain work was
    // cancelled: stop it first and ask the caller to delete again once it has ended.
    if (row.leaseToken && row.leaseUntil > now()) {
      await reply.cancel(principal, row.id, row.leaseToken).catch(() => undefined);
      throw conflict("A reply is still running; it is being stopped. Delete again in a moment.");
    }
    await acknowledgeDeletion(principal, row);
    // The acknowledgement can take a while: everything below applies only to the incarnation
    // the caller was authorized for, so a thread recreated under the same id meanwhile keeps
    // its history and uploads.
    const same = exists(authorizedIncarnation(principal, row));
    const results = await db.batch([
      files.tombstone(row.id, same),
      // Surviving children are detached, never deleted.
      db.update(chats).set({ parentId: null, parentEntryId: null }).where(and(eq(chats.parentId, row.id), same)).returning({ id: chats.id }),
      db.delete(messages).where(and(eq(messages.chatId, row.id), same)),
      ...((adapters.deletion?.({ id: row.id, incarnation: incarnationOf(row) }, same) ?? []) as never[]),
      db.delete(chats).where(admitted(principal, row)).returning({ id: chats.id }),
    ] as never);
    if (!((results.at(-1) ?? []) as { id: string }[]).length) throw conflict("The thread changed. Reload before deleting it.");
    const tombstones = results[0] as AttachmentRow[];
    const detached = (results[1] as { id: string }[]).length;
    const purge = files.purge(tombstones).catch((error) => console.error("thread attachment purge failed; the sweep retries", { threadId: row.id, error }));
    if (adapters.retain) adapters.retain(purge);
    else await purge;
    return { deleted: true as const, detachedChildren: detached };
  }

  /**
   * A provider that asked to be told acknowledges BEFORE anything is removed
   * (it cancels its pending domain work); otherwise the delete fails intact.
   * Fail closed: the obligation recorded at creation, or a provider whose
   * metadata is unavailable, both require the acknowledgement. Only a thread
   * whose originating installation no longer exists (and with it the app's
   * own records) needs none.
   */
  async function acknowledgeDeletion(principal: ThreadPrincipal, row: ThreadRow) {
    if (!row.installationId) return;
    const unavailable = () => new Response("Provider did not acknowledge deletion", { status: 503 });
    const providing = (await installations(principal)).has(row.installationId);
    const descriptors = providing ? await discover(principal, row.installationId) : undefined;
    if (!(await deletionNeedsAcknowledgement(row, providing, descriptors))) return;
    // Unavailable provider metadata never counts as "no acknowledgement needed".
    if (!providing || !descriptors) throw unavailable();
    try {
      await adapters.providers.call(principal, row.installationId, "deleted", { threadId: row.id, type: row.type, context: toThread(row, now()).context });
    } catch (error) {
      console.warn("thread provider did not acknowledge deletion", { threadId: row.id, status: error instanceof Response ? error.status : undefined });
      throw unavailable();
    }
  }
  async function deletionNeedsAcknowledgement(row: ThreadRow, providing: boolean, descriptors: ThreadTypeDescriptor[] | undefined) {
    if (row.notifyDeleted) return true;
    if (descriptors) return Boolean(descriptors.find((candidate) => candidate.type === row.type)?.notify?.includes("deleted"));
    // No metadata: only a provider that no longer exists at all is excused.
    return providing || (await installationExists(row.installationId as string));
  }
  async function installationExists(installationId: string) {
    const [found] = await db.select({ id: appInstallations.id }).from(appInstallations).where(eq(appInstallations.id, installationId));
    return Boolean(found);
  }

  /** Account deletion: remove the person's personal threads and private organization threads (nobody else can read them). */
  /**
   * The statements that remove a person's personal and private threads, for the
   * caller to run in ONE batch with its own account deletion; each runs only while
   * `when` holds, so a failed guard changes nothing. Organization-shared threads stay.
   * Call `purgeFiles` after the batch commits; the sweep retries what it misses.
   */
  async function purgeUserStatements(userId: string, when?: SQL) {
    const ownedWhere = and(eq(chats.userId, userId), or(isNull(chats.organizationId), eq(chats.visibility, "private")),
      // Sessions and workflow records keep their own lifecycle (and evidence).
      eq(chats.workspace, false), isNull(chats.workflow));
    // The ids are re-selected inside the batch, so a thread created after this call is purged too.
    const owned = () => db.select({ id: chats.id }).from(chats).where(ownedWhere);
    const known = (await owned()).map((row) => row.id);
    const statements = [
      db.update(chats).set({ parentId: null, parentEntryId: null }).where(and(inArray(chats.parentId, owned()), when)),
      db.delete(messages).where(and(inArray(messages.chatId, owned()), when)),
      db.delete(chats).where(and(ownedWhere, when)),
    ];
    return { threadIds: known, statements };
  }
  /** Remove the objects of threads a committed purge deleted. */
  async function purgeFiles(threadIds: string[]) {
    for (const id of threadIds) {
      const tombstones = await files.tombstone(id);
      await files.purge(tombstones).catch((error) => console.error("account thread purge failed; the sweep retries", { threadId: id, error }));
    }
  }
  async function purgeUser(userId: string) {
    const { threadIds, statements } = await purgeUserStatements(userId);
    await db.batch(statements as never);
    await purgeFiles(threadIds);
    return threadIds.length;
  }

  const reply = replies(adapters, { requireRow, conversationType, files });

  async function upload(principal: ThreadPrincipal, threadId: string, request: Request) {
    const row = await requireRow(principal, threadId);
    if (platformOwned(row)) throw readOnlyThread();
    await conversationType(principal, row.installationId, row.type, "send");
    return files.upload(row.id, principal.userId, request, async () => {
      if (!(await db.select({ id: chats.id }).from(chats).where(admitted(principal, row))).length) throw notFound();
    }, exists(authorizedIncarnation(principal, row)));
  }

  async function readAttachment(principal: ThreadPrincipal, threadId: string, attachmentId: string) {
    const row = await requireRow(principal, threadId);
    return files.read(row.id, attachmentId, principal.userId, exists(authorizedIncarnation(principal, row)));
  }

  return {
    types, list, get, entries, snapshot, create, update, append, remove, purgeUser, purgeUserStatements, purgeFiles,
    send: reply.send, submission: reply.submission, cancel: reply.cancel,
    upload, readAttachment, sweep: files.sweep,
  };
}
export type ThreadService = ReturnType<typeof createThreadService>;
export type { SubmissionState };

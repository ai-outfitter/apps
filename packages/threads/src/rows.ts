import {
  parseThreadParts,
  threadActor,
  threadAttachmentPath,
  type Thread,
  type ThreadActor,
  type ThreadEntry,
  type ThreadPart,
} from "@ai-outfitter/app-sdk/threads";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { type AttachmentRow, chats, type EntryRow, messages, type ThreadRow } from "./schema";
import type { ThreadPrincipal } from "./types";

export const notFound = () => new Response("Thread not found", { status: 404 });
export const conflict = (message: string) => new Response(message, { status: 409 });
export const forbidden = (message = "Not permitted") => new Response(message, { status: 403 });

/**
 * The threads this principal may read, as one predicate: an organization's
 * shared threads for any of its members, the caller's own private threads in
 * that organization (member context only), or the caller's own personal
 * threads. Relations never widen it; every read applies it again.
 */
export function visibleTo(principal: ThreadPrincipal) {
  if (principal.organizationId) {
    const own = principal.memberContext ? and(eq(chats.userId, principal.userId), eq(chats.visibility, "private")) : undefined;
    return and(eq(chats.organizationId, principal.organizationId), own ? or(eq(chats.visibility, "organization"), own) : eq(chats.visibility, "organization"));
  }
  if (!principal.memberContext) return sql`0`;
  return and(isNull(chats.organizationId), eq(chats.userId, principal.userId));
}

/**
 * The thread incarnation a caller was admitted to: same id, still visible to the
 * caller, and the same creation (time and identity). Every write or read that
 * runs after an await carries it, so a thread deleted and recreated under the
 * same id (perhaps another member's private thread) never matches.
 */
export function admitted(principal: ThreadPrincipal, row: Pick<ThreadRow, "id" | "createdAt" | "creationHash" | "incarnation">) {
  return and(eq(chats.id, row.id), visibleTo(principal), eq(chats.createdAt, row.createdAt),
    row.creationHash === null ? isNull(chats.creationHash) : eq(chats.creationHash, row.creationHash),
    row.incarnation === null ? isNull(chats.incarnation) : eq(chats.incarnation, row.incarnation));
}

/** A thread incarnation's stable key part: its creation token (legacy rows: creation time). */
export const incarnationOf = (row: Pick<ThreadRow, "createdAt" | "incarnation">) => row.incarnation ?? String(row.createdAt);

/** An entry row as constant select columns, for INSERT … SELECT under a guard. */
export function entryColumns(entry: EntryRow) {
  const value = <T>(name: keyof EntryRow) => sql<T>`${entry[name]}`.as(name);
  return Object.fromEntries((Object.keys(messages) as (keyof EntryRow)[])
    .filter((name) => typeof (messages as unknown as Record<string, unknown>)[name] === "object" && name in entry)
    .map((name) => [name, value(name)])) as Record<keyof EntryRow, ReturnType<typeof value>>;
}

/** Whether the principal may change the thread's settings or delete it. */
export function administers(principal: ThreadPrincipal, row: ThreadRow) {
  if (row.userId === principal.userId && principal.memberContext) return true;
  return row.visibility === "organization" && principal.canAdminister && row.organizationId === principal.organizationId;
}

/** Workspace sessions and workflow-run records live in `chats` too; they are platform
 * records with their own evidence, never member conversations: read-only here. */
export const platformOwned = (row: Pick<ThreadRow, "workspace" | "workflow">) => row.workspace || row.workflow !== null;
export const readOnlyThread = () => new Response("Read-only thread type", { status: 405 });

export function toThread(row: ThreadRow, now: number): Thread {
  return {
    ref: { id: row.id },
    id: row.id,
    owner: row.organizationId ? { kind: "organization", id: row.organizationId } : { kind: "user", id: row.userId ?? "" },
    installationId: row.installationId,
    createdBy: row.userId,
    visibility: row.visibility,
    type: row.type,
    typeVersion: row.typeVersion,
    title: row.title,
    status: row.status,
    context: row.contextType && row.contextId
      ? { type: row.contextType, id: row.contextId, ...(row.contextLabel ? { label: row.contextLabel } : {}) }
      : null,
    parent: row.parentId ? { id: row.parentId, entryId: row.parentEntryId } : null,
    pinned: row.pinned,
    working: row.leaseUntil > now && Boolean(row.leaseToken),
    readOnly: platformOwned(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseJSON(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function actorOf(value: string | null, fallback: ThreadActor): ThreadActor {
  const parsed = threadActor.safeParse(parseJSON(value));
  return parsed.success ? parsed.data : fallback;
}

/** An entry for readers: its stored parts (text included), with the files sent with it first. */
export function toEntry(row: EntryRow, files: AttachmentRow[], threadUser: string | null): ThreadEntry {
  const stored = parseThreadParts(parseJSON(row.parts));
  const parts: ThreadPart[] = stored.some((part) => part.type === "text") || !row.content
    ? stored
    : [{ type: "text", text: row.content }, ...stored];
  const attached: ThreadPart[] = files
    .filter((file) => file.messageId === row.id && file.state === "sent")
    .map((file) => ({ type: "file", attachmentId: file.id, filename: file.filename, mediaType: file.mediaType, url: threadAttachmentPath(row.chatId, file.id) }));
  const fallback: ThreadActor = row.role === "assistant" ? { kind: "model", id: "assistant" } : { kind: "member", id: row.actorUserId ?? threadUser ?? "unknown" };
  const actor = actorOf(row.actor, fallback);
  return {
    id: row.id,
    thread: { id: row.chatId },
    role: row.role,
    parts: [...attached, ...parts],
    status: row.status,
    submissionId: row.submissionId,
    sourceKey: row.sourceKey,
    attribution: { actor, origin: actorOf(row.origin, actor), userId: row.actorUserId, installationId: row.installationId },
    metadata: (parseJSON(row.metadata) ?? null) as ThreadEntry["metadata"],
    createdAt: row.createdAt,
    recordedAt: row.recordedAt,
  };
}

/** Keyset cursors: `<number>:<id>`. */
export const encodeCursor = (at: number, id: string) => `${at}:${id}`;
export function decodeCursor(cursor: string | undefined) {
  if (!cursor) return undefined;
  const index = cursor.indexOf(":");
  const at = Number(cursor.slice(0, index));
  if (index < 1 || !Number.isFinite(at)) throw new Response("Invalid cursor", { status: 400 });
  return { at, id: cursor.slice(index + 1) };
}

export async function sha256(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

import { threadAttachmentPath, threadImageTypes, type ThreadAttachment } from "@ai-outfitter/app-sdk/threads";
import { and, eq, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { notFound } from "./rows";
import { attachments, chats, type AttachmentRow } from "./schema";
import type { ThreadAdapters } from "./types";

/** Image limits, as the existing chat input enforces them in the browser. */
export const MAX_THREAD_BYTES = 10 * 1024 * 1024;
export const MAX_THREAD_FILES = 128;
export const MAX_ENTRY_FILES = 4;
/** An unsent upload expires after a day; it stays sendable until an hour before that. */
export const PENDING_MS = 24 * 60 * 60 * 1000;
const SEND_MARGIN_MS = 60 * 60 * 1000;
export const MODEL_URL_SECONDS = 600;

export const objectKey = (row: Pick<AttachmentRow, "chatId" | "id">) => `chats/${row.chatId}/${row.id}`;
const filename = z.string().min(1).max(255).refine((value) =>
  !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "/" || char === "\\"));

function imageMatches(bytes: Uint8Array, mediaType: string) {
  const start = Array.from(bytes.slice(0, 12));
  const ascii = new TextDecoder().decode(bytes.slice(0, 12));
  if (mediaType === "image/png") return [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => start[i] === n);
  if (mediaType === "image/jpeg") return start[0] === 255 && start[1] === 216 && start[2] === 255;
  if (mediaType === "image/gif") return /^(GIF87a|GIF89a)/.test(ascii);
  return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
}

async function readBounded(request: Request, limit: number) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) throw new Response("An image can be up to 10 MB.", { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Response("An image can be up to 10 MB.", { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const attachmentRef = (row: AttachmentRow): ThreadAttachment => ({
  id: row.id,
  filename: row.filename,
  mediaType: z.enum(threadImageTypes).parse(row.mediaType),
  url: threadAttachmentPath(row.chatId, row.id),
});

export function threadAttachments(adapters: ThreadAdapters) {
  const { db, objects } = adapters;
  const now = () => adapters.now?.() ?? Date.now();

  /** Store an image for a thread the uploader may read. `recheck` re-reads the thread's access after the bytes are stored. */
  async function upload(threadId: string, userId: string, request: Request, recheck: () => Promise<unknown>, when?: SQL) {
    const mediaType = z.enum(threadImageTypes).safeParse(request.headers.get("content-type"));
    if (!mediaType.success) throw new Response("Unsupported attachment type", { status: 415 });
    let name: string;
    try {
      name = filename.parse(decodeURIComponent(request.headers.get("x-filename") ?? ""));
    } catch {
      throw new Response("Invalid filename", { status: 400 });
    }
    const bytes = await readBounded(request, MAX_THREAD_BYTES);
    if (!bytes.length || !imageMatches(bytes, mediaType.data)) throw new Response("Invalid image", { status: 422 });
    const at = now();
    const row: AttachmentRow = {
      id: crypto.randomUUID(), userId, chatId: threadId, messageId: null, mediaType: mediaType.data,
      filename: name, size: bytes.length, state: "uploading", createdAt: at, checkedAt: at,
    };
    // One statement admits concurrent uploads against the same thread budget.
    const admitted = await db.all(sql`
      INSERT INTO attachments(id,userId,chatId,messageId,mediaType,filename,size,state,createdAt,checkedAt)
      SELECT ${row.id},${userId},${threadId},NULL,${row.mediaType},${name},${row.size},'uploading',${at},${at}
      WHERE (SELECT COALESCE(SUM(size),0) FROM attachments WHERE chatId=${threadId} AND state IN ('uploading','pending','sent')) + ${row.size} <= ${MAX_THREAD_BYTES}
      AND (SELECT COUNT(*) FROM attachments WHERE chatId=${threadId} AND state IN ('uploading','pending','sent')) < ${MAX_THREAD_FILES}
      ${when ? sql`AND ${when}` : sql``}
      RETURNING id`);
    if (!admitted.length)
      throw new Response("This conversation holds up to 128 images and 10 MB. Start a new conversation to attach more.", { status: 413 });
    try {
      // No browser PUT ticket: only the platform writes this immutable object once.
      await objects.put(objectKey(row), bytes, row.mediaType);
      await recheck();
      await db.update(attachments).set({ state: "pending" }).where(and(eq(attachments.id, row.id), eq(attachments.state, "uploading")));
      return attachmentRef(row);
    } catch (error) {
      // The thread may have been deleted meanwhile: leave a tombstone for the sweep.
      await db.update(attachments).set({ state: "deleting", checkedAt: 0 }).where(eq(attachments.id, row.id));
      throw error;
    }
  }

  /** The caller's own fresh uploads to this thread, in the order named. */
  async function sendable(threadId: string, userId: string, ids: string[]) {
    if (new Set(ids).size !== ids.length) throw new Response("Duplicate attachment", { status: 400 });
    if (ids.length > MAX_ENTRY_FILES) throw new Response("At most four images per message", { status: 400 });
    if (!ids.length) return [];
    const rows = await db.select().from(attachments).where(and(eq(attachments.chatId, threadId), eq(attachments.userId, userId), inArray(attachments.id, ids)));
    const since = now() - PENDING_MS + SEND_MARGIN_MS;
    return ids.map((id) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new Response("Attachment unavailable", { status: 404 });
      if (row.state !== "pending" || row.createdAt <= since)
        throw new Response("Attachment expired or already sent. Attach it again.", { status: 409 });
      return row;
    });
  }

  /** Model input for files: short-lived signed URLs; missing history objects are omitted. */
  async function modelFile(row: AttachmentRow) {
    return { type: "file" as const, data: new URL(await objects.presignGet(objectKey(row), MODEL_URL_SECONDS)), mediaType: row.mediaType, filename: row.filename };
  }

  /** Serve one attachment after `visible` confirms the reader may read its thread. */
  async function read(threadId: string, attachmentId: string, userId: string, when?: SQL) {
    if (!z.uuid().safeParse(attachmentId).success) throw notFound();
    const [row] = await db.select().from(attachments).where(and(eq(attachments.id, attachmentId), eq(attachments.chatId, threadId), when));
    // A pending upload is its uploader's alone; a sent one is the thread's.
    const readable = row && (row.state === "sent" || (row.state === "pending" && row.userId === userId && row.createdAt > now() - PENDING_MS));
    if (!readable) throw new Response("Attachment unavailable", { status: 404 });
    const body = await objects.get(objectKey(row));
    if (!body) throw new Response("Attachment unavailable", { status: 404 });
    return new Response(body as BodyInit, {
      headers: {
        "Content-Type": row.mediaType,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  }

  /** Tombstone a thread's files (all but in-flight uploads, which tombstone themselves);
   * `when` lets a caller batch it under its own guard. */
  function tombstone(threadId: string, when?: SQL) {
    return db.update(attachments).set({ state: "deleting", checkedAt: 0 })
      .where(and(eq(attachments.chatId, threadId), ne(attachments.state, "uploading"), when))
      .returning();
  }

  /** Delete tombstoned objects, then their rows; a failure stays a tombstone for the sweep. */
  async function purge(rows: AttachmentRow[]) {
    for (let offset = 0; offset < rows.length; offset += 100) {
      const batch = rows.slice(offset, offset + 100);
      await objects.delete(batch.map(objectKey));
      await db.delete(attachments).where(and(eq(attachments.state, "deleting"), inArray(attachments.id, batch.map((row) => row.id))));
    }
  }

  /** Bounded cleanup: expire unsent uploads, remove tombstones and files whose thread is gone. */
  async function sweep(at = now()) {
    const rows = await db.select().from(attachments).where(or(
      eq(attachments.state, "deleting"),
      and(inArray(attachments.state, ["pending", "uploading"]), lt(attachments.createdAt, at - PENDING_MS)),
      and(eq(attachments.state, "sent"), lt(attachments.checkedAt, at - PENDING_MS)),
    )).orderBy(attachments.checkedAt).limit(100);
    let removed = 0;
    for (const row of rows) {
      try {
        if (row.state === "sent") {
          const [thread] = await db.select({ id: chats.id }).from(chats).where(eq(chats.id, row.chatId));
          if (thread) {
            await db.update(attachments).set({ checkedAt: at }).where(eq(attachments.id, row.id));
            continue;
          }
        }
        await db.update(attachments).set({ state: "deleting" }).where(eq(attachments.id, row.id));
        await objects.delete([objectKey(row)]);
        await db.delete(attachments).where(and(eq(attachments.id, row.id), eq(attachments.state, "deleting")));
        removed++;
      } catch (error) {
        // Rotate failures behind unchecked rows so one failure cannot starve cleanup.
        await db.update(attachments).set({ checkedAt: at }).where(eq(attachments.id, row.id)).catch(() => {});
        console.error("thread attachment cleanup failed", { attachmentId: row.id, error });
      }
    }
    return removed;
  }

  return { upload, sendable, modelFile, read, tombstone, purge, sweep };
}

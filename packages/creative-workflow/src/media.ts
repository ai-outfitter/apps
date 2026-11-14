import { z } from "zod";
import { requireEditor } from "@ai-outfitter/app-sdk/server";
import { digest } from "./index.ts";
import type { VideoContext } from "./video-store.ts";
export const reserveMediaInput = z.strictObject({
  id: z.uuid(),
  subjectId: z.uuid(),
  filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/),
  contentType: z.enum([
    "image/png",
    "image/jpeg",
    "video/mp4",
    "application/pdf",
    "model/gltf-binary",
    "application/zip",
  ]),
  size: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export async function readMedia(c: VideoContext, id: string) {
  const [row] = await c.store().query({
    sql: "SELECT body,ready FROM creative_media WHERE installationId=? AND id=?",
    params: [c.identity.installationId, id],
  });
  if (!row) throw new Response("Artifact not found", { status: 404 });
  return { ...JSON.parse(String(row.body)), ready: Boolean(row.ready) };
}
export async function reserveMedia(c: VideoContext, raw: unknown) {
  requireEditor(c.identity);
  const input = reserveMediaInput.parse(raw);
  await c.store().batch([
    {
      sql: "INSERT INTO creative_media VALUES (?,?,?,0) ON CONFLICT DO NOTHING",
      params: [c.identity.installationId, input.id, JSON.stringify(input)],
    },
  ]);
  const { ready, ...stored } = await readMedia(c, input.id);
  if (JSON.stringify(stored) !== JSON.stringify(input))
    throw new Response("Artifact ID already used", { status: 409 });
  return {
    asset: stored,
    ready,
    upload: { method: "PUT", path: `/api/media/${input.id}` },
  };
}
export async function uploadMedia(
  c: VideoContext,
  id: string,
  request: Request,
) {
  requireEditor(c.identity);
  const asset = await readMedia(c, id);
  const reader = request.body?.getReader();
  if (!reader) throw new Response("Missing bytes", { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > asset.size) {
      await reader.cancel();
      throw new Response("File exceeds reserved size", { status: 413 });
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (size !== asset.size || (await digest(bytes)) !== asset.sha256)
    throw new Response("Artifact hash or size mismatch", { status: 422 });
  if (!asset.ready) {
    await c.videoFiles!().put("productions", `creative/${id}`, bytes, {
      contentType: asset.contentType,
    });
    await c.store().batch([
      {
        sql: "UPDATE creative_media SET ready=1 WHERE installationId=? AND id=?",
        params: [c.identity.installationId, id],
      },
    ]);
  }
  return readMedia(c, id);
}
export async function downloadMedia(
  c: VideoContext,
  id: string,
  download: boolean,
) {
  const asset = await readMedia(c, id);
  if (!asset.ready)
    throw new Response("Artifact not uploaded", { status: 404 });
  const file = await c.videoFiles!().get({
    space: "productions",
    key: `creative/${id}`,
  });
  if (!file) throw new Response("Artifact expired or missing", { status: 404 });
  return new Response(file.body, {
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(file.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...(download
        ? { "Content-Disposition": `attachment; filename="${asset.filename}"` }
        : {}),
    },
  });
}
export async function listMedia(c: VideoContext, after?: string) {
  const rows = await c.store().query({
    sql: "SELECT id,body FROM creative_media WHERE installationId=? AND ready=1 AND id>? ORDER BY id LIMIT 51",
    params: [c.identity.installationId, after ?? ""],
  });
  return {
    items: rows.slice(0, 50).map((r) => JSON.parse(String(r.body))),
    next: rows.length > 50 ? String(rows[49].id) : null,
  };
}

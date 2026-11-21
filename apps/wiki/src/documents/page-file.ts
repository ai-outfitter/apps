import { requireEditor, sha256Hex } from "@ai-outfitter/app-sdk/server";
import { directUploadReference } from "@ai-outfitter/app-sdk/storage";
import { z } from "zod";
import type { Context } from "./graphql";
import { getPage } from "./store";

export const pageFileInput = z.strictObject({
  pageSlug: z.string().min(1).max(200),
  fileName: z.string().max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  // The platform rewrites mounted HTML and CSS. Store those sources as downloads.
  contentType: directUploadReference.shape.contentType.refine(type => !/^text\/(html|css)\b/i.test(type),
    "Use application/octet-stream for HTML and CSS source downloads"),
  size: directUploadReference.shape.size,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export async function uploadPageFile(ctx: Context, input: z.infer<typeof pageFileInput>) {
  requireEditor(ctx.identity);
  const page = await getPage(ctx.database, input.pageSlug);
  const store = ctx.storage();
  const { fileName, contentType, size, sha256 } = input;
  const file = { contentType, size, sha256 };
  const target = { space: "assets", key: `${page.id}/${sha256}-${fileName}` };
  let object = await store.get(target);
  if (!object) {
    const bytes = await store.takeUpload(target, file);
    if (!bytes) return { status: "awaiting_upload", upload: store.uploadTicket(target, file) };
    await store.put(target.space, target.key, bytes, { contentType });
    object = await store.get(target);
    await store.discardUpload(target, file);
  }
  if (!object) throw new Response("Stored attachment is unavailable", { status: 503 });
  const stored = await new Response(object.body).arrayBuffer();
  if (stored.byteLength !== size || await sha256Hex(stored) !== sha256 || object.contentType !== contentType)
    throw new Response("Stored attachment differs from the declaration", { status: 409 });
  return { status: "attached", pageSlug: page.slug, pageId: page.id, fileName, ...file,
    expiresAt: object.expiresAt, downloadUrl: store.url(target).slice(1) };
}

import { type AppIdentity, requireEditor } from "@ai-outfitter/app-sdk/server";
import {
  artifactUpload,
  type StorageLocals,
  storage,
} from "@ai-outfitter/app-sdk/storage";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { type Database, getNode as page } from "./graph";
import { graphAssets } from "./schema";

const ASSET_SPACE = "assets";
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const valid = (id: string) => z.uuid().safeParse(id).success;
const assetView = (row: typeof graphAssets.$inferSelect) => ({
  ...row,
  url: `files/main/assets/${row.key}`,
});
const contentType = artifactUpload.shape.contentType;
// biome-ignore lint/suspicious/noControlCharactersInRegex: explicitly reject control characters in filenames.
const filename = z
  .string()
  .trim()
  .min(1)
  .max(200)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject unsafe filename control characters.
  .refine((value) => !/[\u0000-\u001f\u007f/\\]/.test(value));

/** Stores the request body as a file of the page: `?filename=` names it, its Content-Type types it. */
export async function uploadAsset(
  db: Database,
  identity: AppIdentity,
  request: Request,
  locals: StorageLocals,
  pageId: string,
) {
  requireEditor(identity);
  const current = await page(db, pageId);
  const url = new URL(request.url);
  const name = filename.safeParse(url.searchParams.get("filename") ?? "");
  const type = contentType.safeParse(
    (request.headers.get("Content-Type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase() || "application/octet-stream",
  );
  if (!name.success || !type.success)
    throw new Response("Name the file and its type", { status: 400 });
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_ASSET_BYTES)
    throw new Response("Files are at most 10 MB", { status: 413 });
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength)
    throw new Response("The file is empty", { status: 400 });
  if (bytes.byteLength > MAX_ASSET_BYTES)
    throw new Response("Files are at most 10 MB", { status: 413 });
  const assetId = crypto.randomUUID();
  const extension = /\.([a-z0-9]{1,10})$/i.exec(name.data)?.[1]?.toLowerCase();
  const key = `${current.id}/${assetId}${extension ? `.${extension}` : ""}`;
  const files = storage(locals, "main");
  await files.put(ASSET_SPACE, key, bytes, { contentType: type.data });
  const row = {
    id: assetId,
    pageId: current.id,
    key,
    filename: name.data,
    contentType: type.data,
    size: bytes.byteLength,
    createdBy: identity.userId,
    createdAt: Date.now(),
  };
  // A page deleted meanwhile fails the row; its file goes too.
  await db
    .insert(graphAssets)
    .values(row)
    .catch(async (error) => {
      await files.delete({ space: ASSET_SPACE, key });
      throw error;
    });
  return assetView(row);
}

export async function deleteAsset(
  db: Database,
  identity: AppIdentity,
  locals: StorageLocals,
  assetId: string,
) {
  requireEditor(identity);
  // The row first: a page never lists a file that is gone.
  const [asset] = valid(assetId)
    ? await db
        .delete(graphAssets)
        .where(eq(graphAssets.id, assetId))
        .returning({ key: graphAssets.key })
    : [];
  if (!asset) throw new Response("File not found", { status: 404 });
  await storage(locals, "main").delete({ space: ASSET_SPACE, key: asset.key });
  return { deleted: true };
}

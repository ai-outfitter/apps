import type { APIRoute } from "astro";
import { context } from "../../../../../server/context";
import {
  readAsset,
  readProduction,
  uploadAssetBytes,
} from "@ai-outfitter/creative-workflow/video-store";
import { downloadName } from "@ai-outfitter/creative-workflow/video-model";
export const GET: APIRoute = async ({ request, params, locals }) => {
  try {
    const c = context(request, locals),
      asset = await readAsset(c, params.id ?? "");
    if (!asset.ready) return new Response("Not found", { status: 404 });
    const production = await readProduction(c, asset.productionId);
    const file = await c.videoFiles!().get({
      space: "productions",
      key: `${asset.productionId}/${asset.id}`,
    });
    if (!file) return new Response("Media expired or missing", { status: 404 });
    const download = new URL(request.url).searchParams.has("download");
    return new Response(file.body, {
      headers: {
        "Content-Type": asset.contentType,
        "Content-Length": String(file.size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        ETag: `"${file.sha256}"`,
        ...(download
          ? {
              "Content-Disposition": `attachment; filename="${asset.contentType === "video/mp4" ? downloadName(production.packet.title, asset.productionRevision) : asset.filename}"`,
            }
          : {}),
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
};

export const PUT: APIRoute = async ({ request, params, locals }) => {
  try {
    const c = context(request, locals);
    if (!c.identity.canEdit)
      return new Response("Editors only", { status: 403 });
    const asset = await readAsset(c, params.id ?? "");
    if (Number(request.headers.get("Content-Length")) > asset.size)
      return new Response("File too large", { status: 413 });
    const reader = request.body?.getReader();
    if (!reader) return new Response("Missing bytes", { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > asset.size) {
        await reader.cancel();
        return new Response("File too large", { status: 413 });
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return Response.json(await uploadAssetBytes(c, asset.id, bytes));
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
};

import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import type { StorageLocals } from "@ai-outfitter/app-sdk/storage";
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { uploadAsset } from "../../../../../../server/assets";
import { getNode } from "../../../../../../server/graph";
import { graphAssets } from "../../../../../../server/schema";
export const POST: APIRoute = ({ params, request, locals }) =>
  respond(() =>
    uploadAsset(
      installationDatabase(),
      requestIdentity(request),
      request,
      locals as StorageLocals,
      params.id ?? "",
    ),
  );
export const GET: APIRoute = ({ params, request }) =>
  respond(async () => {
    requestIdentity(request);
    const db = installationDatabase();
    await getNode(db, params.id ?? "");
    return (
      await db
        .select()
        .from(graphAssets)
        .where(eq(graphAssets.pageId, params.id ?? ""))
    ).map((row) => ({ ...row, url: `files/main/assets/${row.key}` }));
  });

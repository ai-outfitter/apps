import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import type { StorageLocals } from "@ai-outfitter/app-sdk/storage";
import type { APIRoute } from "astro";
import { deleteAsset } from "../../../../../server/assets";

export const DELETE: APIRoute = ({ params, request, locals }) =>
  respond(() =>
    deleteAsset(
      installationDatabase(),
      requestIdentity(request),
      locals as StorageLocals,
      params.id ?? "",
    ),
  );

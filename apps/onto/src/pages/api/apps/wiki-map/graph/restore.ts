import { z } from "zod";
import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import {
  readJSON,
  requestIdentity,
  respond,
} from "@ai-outfitter/app-sdk/server";
import {
  graphTransfer,
  restoreGraph,
} from "../../../../../server/graph-transfer";

const previewedTransfer = z.strictObject({
  transfer: graphTransfer,
  previewToken: z.string().regex(/^[a-f0-9]{64}$/),
});

export const POST: APIRoute = ({ request }) =>
  respond(async () => {
    const input = await readJSON(
      request,
      previewedTransfer,
      4_000_000,
    );
    const who = requestIdentity(request);
    const result = await restoreGraph(
      installationDatabase(),
      who,
      input.transfer,
      { previewToken: input.previewToken },
    );
    return {
      ...result,
      receipt: {
        id: crypto.randomUUID(),
        operation: "import",
        installationId: who.installationId,
        owner: who.owner,
        userId: who.userId,
        previewToken: input.previewToken,
        completedAt: new Date().toISOString(),
        conflictPolicy: "reject",
      },
    };
  });

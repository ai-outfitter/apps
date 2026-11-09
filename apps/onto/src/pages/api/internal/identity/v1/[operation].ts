import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { entityRef } from "@ai-outfitter/app-sdk/entities";
import {
  requestIdentity,
  respond,
  readJSON,
} from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import {
  resolveIdentity,
  linkIdentity,
  listIdentities,
  unlinkIdentity,
} from "../../../../../server/identity";

const subject = z.string().min(1).max(300);
export const POST: APIRoute = ({ request, params }) =>
  respond(async () => {
    const who = requestIdentity(request);
    const db = installationDatabase();
    switch (params.operation) {
      case "resolve":
        return resolveIdentity(
          db,
          await readJSON(
            request,
            z.strictObject({
              principalId: subject,
              reference: entityRef.optional(),
            }),
            1024,
          ),
        );
      case "list":
        return listIdentities(db, who);
      case "link":
        return linkIdentity(
          db,
          who,
          await readJSON(
            request,
            z.strictObject({
              holderId: z.uuid(),
              principalId: subject,
              kind: z.enum(["human", "agent"]),
            }),
            1024,
          ),
        );
      case "unlink":
        return unlinkIdentity(
          db,
          who,
          (
            await readJSON(
              request,
              z.strictObject({ holderId: z.uuid() }),
              1024,
            )
          ).holderId,
        );
      default:
        throw new Response("Not found", { status: 404 });
    }
  });

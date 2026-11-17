import { agentDatabase, installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { dataTransferRoutes } from "@ai-outfitter/app-sdk/data-transfer";
import type { APIRoute } from "astro";
import app from "../../../../../app.json";
import { guardedArchive } from "../../../../server/guarded-archive";
import { readGraph } from "../../../../server/graph";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { archiveImportExclusions } from "../../../../server/archive-authorities";

// Standard installation archive (docs/plans/app-data-export.md). Confirmation
// receipts authenticate a member of this installation and cannot become
// approvals elsewhere; the change log holds this installation's idempotency
// receipts; runtime authorities cannot be restored from caller-authored archives.
// Export still retains every app table for backup; this is an import boundary.
export const ALL: APIRoute = context => respond(async () => {
  const who = requestIdentity(context.request);
  const guarded = guardedArchive(agentDatabase(), () => readGraph(installationDatabase(), who), who);
  return dataTransferRoutes(() => guarded.database, {
    app: app.id,
    exclude: [...archiveImportExclusions],
    validate: guarded.validate,
  })(context);
});

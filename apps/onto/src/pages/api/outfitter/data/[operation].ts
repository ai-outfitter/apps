import { agentDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { dataTransferRoutes } from "@ai-outfitter/app-sdk/data-transfer";
import type { APIRoute } from "astro";
import app from "../../../../../app.json";
import { validateGraphImport } from "../../../../server/data-transfer";
import { archiveImportExclusions } from "../../../../server/archive-authorities";

// Standard installation archive (docs/plans/app-data-export.md). Confirmation
// receipts authenticate a member of this installation and cannot become
// approvals elsewhere; the change log holds this installation's idempotency
// receipts; runtime authorities cannot be restored from caller-authored archives.
// Export still retains every app table for backup; this is an import boundary.
export const ALL: APIRoute = dataTransferRoutes(agentDatabase, {
  app: app.id,
  exclude: [...archiveImportExclusions],
  validate: validateGraphImport,
});

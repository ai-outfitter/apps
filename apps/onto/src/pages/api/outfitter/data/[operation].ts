import { agentDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { dataTransferRoutes } from "@ai-outfitter/app-sdk/data-transfer";
import type { APIRoute } from "astro";
import app from "../../../../../app.json";
import { validateGraphImport } from "../../../../server/data-transfer";

// Standard installation archive (docs/plans/app-data-export.md). Confirmation
// receipts authenticate a member of this installation and cannot become
// approvals elsewhere; the change log holds this installation's idempotency
// receipts; asset bytes and agent conversations stay behind.
export const ALL: APIRoute = dataTransferRoutes(agentDatabase, {
  app: app.id,
  exclude: [
    "graph_assertion_confirmations",
    "graph_changes",
    "graph_assets",
    "wiki_map_agent_conversations",
    "wiki_map_agent_turns",
    "wiki_map_agent_proposals",
    "wiki_map_proposals",
  ],
  validate: validateGraphImport,
});

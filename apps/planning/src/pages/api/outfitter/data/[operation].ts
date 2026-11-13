import { agentDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { dataTransferRoutes } from "@ai-outfitter/app-sdk/data-transfer";
import type { APIRoute } from "astro";
import app from "../../../../../app.json";

// Standard installation archive (docs/plans/app-data-export.md).
export const ALL: APIRoute = dataTransferRoutes(agentDatabase, { app: app.id, exclude: ["planning_video_takes", "planning_video_assets"] });

import type { APIRoute } from "astro";
import { respond } from "@ai-outfitter/app-sdk/server";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { exportWorkshopProject } from "../../../../../../server/projects";

export const GET: APIRoute = ({ params }) =>
  respond(() => exportWorkshopProject(installationDatabase(), params.id ?? ""));

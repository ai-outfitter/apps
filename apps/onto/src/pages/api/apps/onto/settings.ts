import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { readJSON, requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import type { APIRoute } from "astro";
import { readSettings, saveSettings, settingsInput } from "../../../../server/settings";

// Onto's settings page: read them, and an admin saves them.
export const GET: APIRoute = () => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") return new Response("Read-only demo", { status: 403 });
  return respond(() => readSettings(installationDatabase()));
};
export const POST: APIRoute = ({ request }) => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") return new Response("Read-only demo", { status: 403 });
  return respond(async () => saveSettings(installationDatabase(), requestIdentity(request), await readJSON(request, settingsInput, 1000)));
};

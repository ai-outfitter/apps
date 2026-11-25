import type { APIRoute } from "astro";
import { respond } from "@ai-outfitter/app-sdk/server";
import { foundryContext } from "../../../../../server/context";
import { findPlanInput, readPlanArtifact } from "../../../../../server/planning";

export const GET: APIRoute = ({ request, locals, params }) => respond(async () => {
  const input = findPlanInput.safeParse(params);
  if (!input.success) return new Response("Plan artifact not found", { status: 404 });
  const body = await readPlanArtifact(foundryContext(request, locals), input.data);
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" } });
});

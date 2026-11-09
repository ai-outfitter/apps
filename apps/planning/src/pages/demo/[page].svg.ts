import type { APIRoute } from "astro";
import apps from "../../fixtures/apps.svg?raw";
import workspace from "../../fixtures/workspace.svg?raw";
export const GET: APIRoute = ({ params }) => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "demo") return new Response("Not found", { status: 404 });
  const body = params.page === "workspace" ? workspace : params.page === "apps" ? apps : null;
  return body ? new Response(body, { headers: { "Content-Type": "image/svg+xml" } }) : new Response("Not found", { status: 404 });
};

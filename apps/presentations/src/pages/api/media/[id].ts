import type { APIRoute } from "astro";
import { context } from "../../../server/context";
import {
  downloadMedia,
  uploadMedia,
} from "@ai-outfitter/creative-workflow/media";
export const GET: APIRoute = async ({ request, params, locals }) => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
    return new Response("Not found", { status: 404 });
  try {
    return await downloadMedia(
      context(request, locals),
      params.id ?? "",
      new URL(request.url).searchParams.has("download"),
    );
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
export const PUT: APIRoute = async ({ request, params, locals }) => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
    return new Response("Not found", { status: 404 });
  try {
    return Response.json(
      await uploadMedia(context(request, locals), params.id ?? "", request),
    );
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

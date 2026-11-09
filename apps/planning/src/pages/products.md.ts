import type { APIRoute } from "astro";
import { planningContext } from "../server/context";
import {
  readProductPage,
  productPageMarkdown,
} from "../server/product-page-data";
import { respond } from "@ai-outfitter/app-sdk/server";

export const GET: APIRoute = ({ request, locals, url }) =>
  respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      return new Response(
        "Markdown export requires an installed organization app",
        { status: 404 },
      );
    const context = planningContext(request, locals);
    const page = await readProductPage(
      context.host(),
      context.identity,
      url.searchParams.get("at"),
    );
    return new Response(productPageMarkdown(page), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    });
  });

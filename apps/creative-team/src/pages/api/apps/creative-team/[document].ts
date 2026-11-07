import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { creativeContext } from "../../../../server/context";
import { documents, runDocument } from "../../../../server/documents";

// The pages' writes run the same documents agents run with graph_mutate, by name.
const pageWrites = ["SaveBrandAnswer", "SaveSource", "DeleteSource", "SaveContentProfile", "AddMapBranch", "SaveMapNode", "DeleteMapNode", "SaveDraft", "DeleteDraft"] as const;
type PageWrite = (typeof pageWrites)[number];

export const POST: APIRoute = ({ request, params }) =>
  respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational") throw new Response("Read-only demo", { status: 403 });
    const name = params.document as PageWrite;
    if (!pageWrites.includes(name)) throw new Response("Not found", { status: 404 });
    const { input } = await readJSON(request, z.strictObject({ input: z.record(z.string(), z.unknown()) }), 200_000);
    // biome-ignore lint/suspicious/noExplicitAny: each document validates its own input.
    return runDocument(documents[name].document as any, { input }, creativeContext(request));
  });

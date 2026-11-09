import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import type { APIRoute } from "astro";
import { forerunnerContext } from "../../../../../server/context";
import { documents, runDocument } from "../../../../../server/documents";
import { listItems, reorderInput } from "../../../../../server/items";
/** Moving an item runs the ReorderItems document agents run with graph_mutate, and answers the board as GET serves it. */
export const POST: APIRoute = ({ request, locals }) =>
	respond(async () => {
		const context = forerunnerContext(request, locals);
		const input = await readJSON(request, reorderInput, 60000);
		await runDocument(documents.ReorderItems.document, { input }, context);
		return { items: await listItems(context.db(), context.identity) };
	});

import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import {
	readJSON,
	requestIdentity,
	respond,
} from "@ai-outfitter/app-sdk/server";
import type { APIRoute } from "astro";
import { forerunnerContext } from "../../../../../server/context";
import { documents, runDocument } from "../../../../../server/documents";
import {
	createInput,
	findItem,
	listItems,
} from "../../../../../server/items";
export const GET: APIRoute = ({ request }) =>
	respond(async () => ({
		items: await listItems(installationDatabase(), requestIdentity(request)),
	}));
/** The board adds an item through the same CreateItem document agents run with
 * graph_mutate, and gets the row back as GET serves it. */
export const POST: APIRoute = ({ request, locals }) =>
	respond(async () => {
		const context = forerunnerContext(request, locals);
		const input = await readJSON(request, createInput, 24000);
		const { createItem } = await runDocument(documents.CreateItem.document, { input }, context);
		return findItem(context.db(), context.identity, createItem.id);
	});

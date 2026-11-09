import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import type { APIRoute } from "astro";
import { forerunnerContext } from "../../../../../server/context";
import { documents, runDocument } from "../../../../../server/documents";
import {
	deleteInput,
	findItem,
	updateInput,
} from "../../../../../server/items";
// Edits, completions and deletions run the UpdateItem and DeleteItem documents
// agents run with graph_mutate; the path names the item.
export const PUT: APIRoute = ({ request, params, locals }) =>
	respond(async () => {
		const context = forerunnerContext(request, locals);
		const input = await readJSON(request, updateInput, 24000);
		const { updateItem } = await runDocument(documents.UpdateItem.document, { input: { ...input, id: params.id ?? "" } }, context);
		return findItem(context.db(), context.identity, updateItem.id);
	});
export const DELETE: APIRoute = ({ request, params, locals }) =>
	respond(async () => {
		const { revision } = await readJSON(request, deleteInput, 1000);
		const { deleteItem } = await runDocument(documents.DeleteItem.document, { input: { id: params.id ?? "", revision } }, forerunnerContext(request, locals));
		return deleteItem;
	});

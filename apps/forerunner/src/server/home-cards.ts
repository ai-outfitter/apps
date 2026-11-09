import {
	defineHomeCard,
	type HomeCardActionContext,
	type HomeCardNode,
	type HomeCardProvider,
	type HomeCardSize,
} from "@ai-outfitter/app-sdk/home-cards";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { type Database, findItem, listItems, updateItem } from "./items";
import type { Item } from "./schema";

// Home card for a portal homepage (docs/home-cards.md at the webapp root). It
// lists the viewer's actual unfinished board items, never inferred suggestions,
// and reads and completes only their own items in this installation, through
// the same scoped helpers as the board's API: organization administrators have
// no wider reach here than on the board itself.

const counts: Record<HomeCardSize, number> = { small: 1, medium: 3, large: 5 };
const rank: Record<Item["category"], number> = { stone: 0, pebble: 1, sand: 2 };
const names: Record<Item["category"], string> = {
	stone: "Stone",
	pebble: "Pebble",
	sand: "Sand",
};
const completeInput = z.strictObject({ itemId: z.uuid() });

const clip = (value: string, max: number) =>
	value.length > max ? `${value.slice(0, max - 1)}…` : value;
// The board scrolls to and focuses `?item=` once it loads.
const itemPath = (id: string) => `/board?item=${id}`;

/** Unfinished items in board priority: stones, pebbles, then sand, each in the member's order. */
export async function openPriorities(db: Database, who: AppIdentity) {
	const all = await listItems(db, who);
	const open = all
		.filter((item) => item.status !== "done")
		.sort((a, b) => rank[a.category] - rank[b.category]);
	return { all, open };
}

function subtitle(item: Item, all: Item[]) {
	const parent = item.parentId && all.find((v) => v.id === item.parentId);
	return clip(
		parent ? `${names[item.category]} · ${parent.title}` : names[item.category],
		500,
	);
}

function entry(item: Item, all: Item[]) {
	return {
		id: item.id,
		title: clip(item.title, 120),
		subtitle: subtitle(item, all),
		...(item.dueDate ? { meta: `Due ${item.dueDate}` } : {}),
		status:
			item.status === "in-progress"
				? { label: "In progress", tone: "info" as const }
				: { label: "To do", tone: "neutral" as const },
		link: { path: itemPath(item.id) },
		children: [
			{
				kind: "action" as const,
				actionId: "complete-item",
				label: "Complete",
				input: { itemId: item.id },
				revision: item.revision,
				style: "secondary" as const,
			},
		],
	};
}

export async function readPriorities(
	db: Database,
	who: AppIdentity,
	size: HomeCardSize,
): Promise<HomeCardNode[]> {
	const { all, open } = await openPriorities(db, who);
	if (!open.length)
		return [
			{
				kind: "empty",
				text: "No unfinished tasks on your board. Add a stone to set your next priority.",
				link: { kind: "link", label: "Open board", target: { path: "/board" } },
			},
		];
	const shown = open.slice(0, counts[size]);
	const more = open.length - shown.length;
	return [
		...(size === "large"
			? ([
					{ kind: "metric", label: "Open", value: open.length },
					{
						kind: "metric",
						label: "In progress",
						value: open.filter((v) => v.status === "in-progress").length,
					},
				] satisfies HomeCardNode[])
			: []),
		{
			kind: "list",
			label: "Your unfinished tasks",
			items: shown.map((item) => entry(item, all)),
		},
		{
			kind: "link",
			label: more ? `${more} more on your board` : "Open board",
			target: { path: "/board" },
		},
	];
}

/** Completes one of the viewer's own items at the revision the card showed. */
export async function completeItem(
	db: Database,
	who: AppIdentity,
	{ input, revision }: Pick<HomeCardActionContext, "input" | "revision">,
) {
	const parsed = completeInput.safeParse(input);
	if (!parsed.success || revision === undefined)
		throw new Response("Invalid item", { status: 400 });
	const item = await findItem(db, who, parsed.data.itemId);
	if (!item) throw new Response("Item not found", { status: 404 });
	if (item.status === "done")
		return { outcome: "unchanged" as const, message: "Already complete." };
	const { category, title, description, dueDate, parentId } = item;
	try {
		await updateItem(db, who, item.id, {
			category,
			title,
			description,
			dueDate,
			parentId,
			status: "done",
			revision,
		});
	} catch (error) {
		if (!(error instanceof Response && error.status === 409)) throw error;
		const latest = await findItem(db, who, item.id);
		if (latest?.status === "done")
			return { outcome: "unchanged" as const, message: "Already complete." };
		return {
			outcome: "conflict" as const,
			message: "This item changed. Reload the card before completing it.",
		};
	}
	return { outcome: "applied" as const, message: "Completed." };
}

export function homeCards(db: () => Database): HomeCardProvider[] {
	return [
		defineHomeCard({
			cardId: "my-priorities",
			title: "My tasks",
			description:
				"Tasks you added to your board and have not finished, in your board's order.",
			sizes: ["small", "medium", "large"],
			defaultSize: "medium",
			read: async ({ identity, size }) => ({
				body: await readPriorities(db(), identity, size),
			}),
			actions: {
				"complete-item": ({ identity, input, revision }) =>
					completeItem(db(), identity, { input, revision }),
			},
		}),
	];
}

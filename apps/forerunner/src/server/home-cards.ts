import {
	defineHomeCard,
	type HomeCardActionContext,
	type HomeCardListItem,
	type HomeCardNode,
	type HomeCardProvider,
	type HomeCardSize,
} from "@ai-outfitter/app-sdk/home-cards";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { discoveryRuns } from "./discovery";
import { type Database, findItem, listItems, updateItem } from "./items";
import type { Item } from "./schema";
import { latestSuggestionStatus, listSuggestions, updateSuggestion } from "./suggestions";

// Home card for a portal homepage. It
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

type FeedView = "all" | "quick-ones" | "routines" | "role";

type FeedSuggestion = Awaited<ReturnType<typeof listSuggestions>>[number];
type FeedHost = () => WorkflowHost<"interactive">;

async function feedRole(view: FeedView, host?: FeedHost) {
 if (view !== "role" || !host) return { role: null, profileFailed: false };
 try { return { role: (await host().call("profile.read", {})).work?.suspectedRole.title ?? null, profileFailed: false }; }
 catch { return { role: null, profileFailed: true }; }
}

function matchesView(s: FeedSuggestion, view: FeedView, role: string | null) {
 if (view === "all") return true;
 if (view === "quick-ones") return s.kind === "task";
 if (view === "routines") return s.kind === "workflow" || s.kind === "change";
 return !!role && s.roleRelevance?.title.toLowerCase() === role.toLowerCase();
}

async function feedTimezone(host: FeedHost | undefined, suggestions: FeedSuggestion[]) {
 if (!host || !suggestions.some((s) => s.kind === "workflow")) return "UTC";
 try { return (await host().call("schedules", {})).find((s) => s.workflowId === "forerunner-discovery")?.timezone ?? "UTC"; }
 catch { return "UTC"; }
}

function suggestionEntry(s: FeedSuggestion, timezone: string): HomeCardListItem {
 const children: HomeCardNode[] = [];
 if (s.kind !== "app") {
  const verb = s.status === "applying" ? "Retry" : "Apply";
  const label = s.kind === "workflow" ? `${verb} (${timezone})` : s.status === "applying" ? "Retry apply" : "Apply";
  children.push({ kind: "action", actionId: "apply-suggestion", label, input: { id: s.id, ...(s.kind === "workflow" ? { timezone } : {}) }, style: "primary" });
 }
 if (s.status === "open") children.push({ kind: "action", actionId: "dismiss-suggestion", label: "Dismiss", input: { id: s.id }, style: "secondary" });
 return { id: s.id, title: clip(s.title, 120), subtitle: clip(`${s.why}${s.roleRelevance ? ` · ${s.roleRelevance.reason}` : ""} · Discovery run ${s.runId}`, 500), link: { path: "/workflows#suggestions" }, children };
}

function feedEntries(view: FeedView, board: Awaited<ReturnType<typeof openPriorities>>, chosen: FeedSuggestion[], timezone: string) {
 const boardItems = view === "all" ? board.open : view === "quick-ones" ? board.open.filter((item) => item.category === "sand") : [];
 // Accepted one-off tasks retain the suggestion ID; titles are not identities.
 const seen = new Set(boardItems.map((item) => item.id));
 const unique = chosen.filter((suggestion) => { if (seen.has(suggestion.id)) return false; seen.add(suggestion.id); return true; });
 return [...boardItems.map((item) => entry(item, board.all)), ...unique.map((s) => suggestionEntry(s, timezone))];
}

function feedBody(entries: HomeCardListItem[], view: FeedView, role: string | null, profileFailed: boolean, runFailed: boolean, suggestionsFailed: boolean): HomeCardNode[] {
 const body: HomeCardNode[] = [];
 if (suggestionsFailed) body.push({ kind: "notice", tone: "warning", text: "The latest suggestion generation failed. Earlier suggestions remain available." });
 if (runFailed) body.push({ kind: "notice", tone: "warning", text: "Your latest discovery run failed. Open its history to review and retry." }, { kind: "link", label: "Review discovery history", target: { path: "/history" } });
 if (view === "role" && !role) body.push({ kind: "notice", tone: "info", text: profileFailed ? "Your work profile could not be loaded. Try again later." : "Add your work profile to see suggestions for your role." });
 if (!entries.length) body.push({ kind: "empty", text: "No suggestions or tasks here yet." });
 else {
  body.push({ kind: "list", items: entries.slice(0, 20) });
  if (entries.length > 20) body.push({ kind: "text", text: `Showing 20 of ${entries.length}. Open your board or suggestions to see the rest.` }, { kind: "link", label: "Open board", target: { path: "/board" } }, { kind: "link", label: "Open suggestions", target: { path: "/workflows#suggestions" } });
 }
 return body;
}

async function readFeed(db: Database, identity: AppIdentity, view: FeedView, label: string, host?: FeedHost) {
 const [board, suggestions, runs, status, profile] = await Promise.all([openPriorities(db, identity), listSuggestions(db, identity), discoveryRuns(db, identity), latestSuggestionStatus(db, identity), feedRole(view, host)]);
 const chosen = suggestions.filter((s) => matchesView(s, view, profile.role));
 const timezone = await feedTimezone(host, chosen);
 const entries = feedEntries(view, board, chosen, timezone);
 return { title: profile.role ? clip(`For ${profile.role}`, 120) : label, body: feedBody(entries, view, profile.role, profile.profileFailed, runs[0]?.status === "failed", status?.status === "failed") };
}

function feedCard(db: () => Database, host: FeedHost | undefined, view: FeedView, label: string, order: number): HomeCardProvider {
 return defineHomeCard({
   cardId: `feed-${view}`, title: label, can: (identity) => identity.owner.kind === "user" && identity.canEdit, surfaces: ["for-you"], view: { id: view, label, order }, sizes: ["large"], defaultSize: "large",
   read: ({ identity }) => readFeed(db(), identity, view, label, host),
   actions: {
     "complete-item": ({ identity, input, revision }) => completeItem(db(), identity, { input, revision }),
     "apply-suggestion": async ({ identity, input }) => { const value = z.strictObject({ id: z.uuid(), timezone: z.string().min(1).max(64).optional() }).parse(input); if (!host) throw new Response("Host unavailable", { status: 503 }); await updateSuggestion(db(), identity, host(), { ...value, status: "applied" }); return { outcome: "applied" as const }; },
     "dismiss-suggestion": async ({ identity, input }) => { const value = z.strictObject({ id: z.uuid() }).parse(input); if (!host) throw new Response("Host unavailable", { status: 503 }); await updateSuggestion(db(), identity, host(), { ...value, status: "dismissed" }); return { outcome: "applied" as const }; },
   },
 });
}

export function homeCards(db: () => Database, host?: FeedHost): HomeCardProvider[] {
 const feed = ([ ["all", "All"], ["quick-ones", "Quick Ones"], ["routines", "Routines"], ["role", "For your role"] ] as const).map(([view, label], order) => feedCard(db, host, view, label, order));
 return [...feed,
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

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	homeCardAPI,
	homeCardCatalog,
	homeCardReadResult,
} from "@ai-outfitter/app-sdk/home-cards";
import {
	type AppIdentity,
	identityHeaderValues,
} from "@ai-outfitter/app-sdk/server";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { discoveryRecords } from "../src/server/schema";
import { homeCards } from "../src/server/home-cards";
import {
	createItem,
	listItems,
	reorderItems,
	updateItem,
} from "../src/server/items";

// Synthetic members of one organization installation, and a personal install.
const org = { kind: "organization" as const, id: "org" };
const alice: AppIdentity = {
	userId: "alice",
	installationId: "one",
	organizationId: "org",
	owner: org,
	role: "member",
	canEdit: false,
};
const admin: AppIdentity = { ...alice, userId: "admin", role: "admin", canEdit: true };
const otherInstall: AppIdentity = { ...alice, installationId: "two" };
const personal: AppIdentity = {
	userId: "alice",
	installationId: "mine",
	owner: { kind: "user", id: "alice" },
	role: "owner",
	canEdit: true,
};

const value = (
	title: string,
	category = "stone",
	parentId: string | null = null,
	status = "todo",
) => ({ title, category, parentId, description: "", dueDate: null, status });

async function setup(host?: Parameters<typeof homeCards>[1]) {
	const client = createClient({ url: ":memory:" });
	const db = drizzle(client);
	await migrate(db, {
		migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
	});
	const cards = homeCards(() => db, host);
	// A request exactly as platform dispatch forwards it for `who`.
	const call = async (operation: string, who: AppIdentity, body?: unknown) => {
		const { canEdit: _, ...identity } = who;
		const response = await homeCardAPI(
			new Request(`https://forerunner.internal/api/internal/home-cards/v1/${operation}`, {
				method: body === undefined ? "GET" : "POST",
				headers: {
					...identityHeaderValues(identity),
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
			operation,
			cards,
		);
		return {
			status: response.status,
			body: response.ok ? await response.json() : await response.text(),
		};
	};
	const read = async (who: AppIdentity, size = "large") => {
		const result = await call("read", who, { cardId: "my-priorities", size });
		assert.equal(result.status, 200);
		return homeCardReadResult.parse(result.body);
	};
	const complete = (who: AppIdentity, input: unknown, revision?: unknown) =>
		call("action", who, {
			cardId: "my-priorities",
			actionId: "complete-item",
			input,
			...(revision === undefined ? {} : { revision }),
		});
	return { db, client, call, read, complete };
}

type ReadyBody = Extract<
	ReturnType<typeof homeCardReadResult.parse>,
	{ status: "ready" }
>["body"];
const listOf = (body: ReadyBody) => {
	const list = body.find((node) => node.kind === "list");
	assert.ok(list && list.kind === "list");
	return list.items;
};
const ready = (result: ReturnType<typeof homeCardReadResult.parse>) => {
	assert.equal(result.status, "ready");
	return result.body;
};

test("the catalog declares one priorities card with its complete action", async () => {
	const { call, client } = await setup();
	try {
		for (const who of [alice, admin, personal]) {
			const { status, body } = await call("catalog", who);
			assert.equal(status, 200);
			assert.deepEqual(homeCardCatalog.parse(body).cards.filter((card) => card.cardId === "my-priorities"), [
				{
					cardId: "my-priorities",
					title: "My tasks",
					description:
						"Tasks you added to your board and have not finished, in your board's order.",
					sizes: ["small", "medium", "large"],
					defaultSize: "medium",
					actionIds: ["complete-item"],
				},
			]);
		}
		assert.equal((await call("read", alice, { cardId: "other", size: "small" })).status, 404);
	} finally {
		client.close();
	}
});

test("reads unfinished own items in board priority at 1/3/5 per size", async () => {
	const { db, client, read } = await setup();
	try {
		const empty = ready(await read(alice, "medium"));
		assert.equal(empty.length, 1);
		assert.equal(empty[0].kind, "empty");

		const sand = await createItem(db, alice, value("Sand first created", "sand"));
		const launch = await createItem(db, alice, value("Launch"));
		const hire = await createItem(db, alice, value("Hire"));
		const finished = await createItem(db, alice, value("Shipped", "stone", null, "done"));
		const pebble = await createItem(db, alice, value("Draft plan", "pebble", launch.id));
		const reorderedFirst = await createItem(db, alice, {
			...value("Fundraise", "stone", null, "in-progress"),
			dueDate: "2026-11-02",
		});
		await createItem(db, alice, value("Extra sand", "sand"));
		// Another member's work, and the same member elsewhere, never appear.
		await createItem(db, admin, value("Admin stone"));
		await createItem(db, otherInstall, value("Other install stone"));
		// Move Fundraise to the top of the stone row using the board's own reorder.
		const stones = (await listItems(db, alice)).filter((v) => v.category === "stone");
		const order = [stones.find((v) => v.id === reorderedFirst.id), ...stones.filter((v) => v.id !== reorderedFirst.id)];
		await reorderItems(db, alice, { items: order.map((v) => ({ id: v?.id, revision: v?.revision })) });

		const large = ready(await read(alice, "large"));
		assert.deepEqual(
			large.filter((node) => node.kind === "metric"),
			[
				{ kind: "metric", label: "Open", value: 6 },
				{ kind: "metric", label: "In progress", value: 1 },
			],
		);
		const items = listOf(large);
		assert.deepEqual(
			items.map((item) => item.title),
			["Fundraise", "Launch", "Hire", "Draft plan", "Sand first created"],
		);
		assert.ok(!JSON.stringify(large).includes(finished.id));
		assert.ok(!/Admin stone|Other install stone|Shipped/.test(JSON.stringify(large)));
		const [top, , , child, first] = items;
		assert.deepEqual(top.status, { label: "In progress", tone: "info" });
		assert.equal(top.meta, "Due 2026-11-02");
		assert.deepEqual(top.link, { path: `/items/${reorderedFirst.id}` });
		assert.equal(child.subtitle, "Pebble · Launch");
		assert.equal(first.id, sand.id);
		assert.deepEqual(child.children, [
			{
				kind: "action",
				actionId: "complete-item",
				label: "Complete",
				input: { itemId: pebble.id },
				revision: pebble.revision,
				style: "secondary",
			},
		]);
		assert.deepEqual(large.at(-1), { kind: "link", label: "1 more on your board", target: { path: "/board" } });

		const small = ready(await read(alice, "small"));
		assert.deepEqual(listOf(small).map((item) => item.title), ["Fundraise"]);
		assert.equal(small.some((node) => node.kind === "metric"), false);
		const medium = ready(await read(alice, "medium"));
		assert.deepEqual(listOf(medium).map((item) => item.id), [reorderedFirst.id, launch.id, hire.id]);
		assert.deepEqual(medium.at(-1), { kind: "link", label: "3 more on your board", target: { path: "/board" } });
	} finally {
		client.close();
	}
});

test("personal installs are scoped to their owner and installation", async () => {
	const { db, client, read, complete } = await setup();
	try {
		const own = await createItem(db, personal, value("Personal stone"));
		await createItem(db, alice, value("Org stone"));
		assert.deepEqual(listOf(ready(await read(personal))).map((v) => v.title), ["Personal stone"]);
		assert.deepEqual(listOf(ready(await read(alice))).map((v) => v.title), ["Org stone"]);
		// Same user, other installation: the personal item does not exist there.
		assert.equal((await complete(alice, { itemId: own.id }, own.revision)).status, 404);
		assert.deepEqual((await complete(personal, { itemId: own.id }, own.revision)).body, {
			version: 1,
			outcome: "applied",
			message: "Completed.",
		});
		assert.equal(ready(await read(personal))[0].kind, "empty");
	} finally {
		client.close();
	}
});

test("a member completes their own item once; repeats and stale revisions never mutate", async () => {
	const { db, client, read, complete } = await setup();
	try {
		const item = await createItem(db, alice, value("Launch"));
		// The board edits it after the card was read: the card's revision is stale.
		const edited = await updateItem(db, alice, item.id, { ...value("Launch v2"), revision: item.revision });
		const stale = await complete(alice, { itemId: item.id }, item.revision);
		assert.equal(stale.status, 200);
		assert.equal((stale.body as { outcome: string }).outcome, "conflict");
		const [unchanged] = await listItems(db, alice);
		assert.deepEqual(
			{ status: unchanged.status, revision: unchanged.revision, title: unchanged.title },
			{ status: "todo", revision: edited.revision, title: "Launch v2" },
		);

		// Non-editor member, no canEdit gate: completes at the current revision.
		const applied = await complete(alice, { itemId: item.id }, edited.revision);
		assert.deepEqual(applied.body, { version: 1, outcome: "applied", message: "Completed." });
		const [done] = await listItems(db, alice);
		assert.deepEqual({ status: done.status, revision: done.revision, title: done.title }, { status: "done", revision: edited.revision + 1, title: "Launch v2" });

		// Repeats are safe no-ops, with the old or the new revision.
		for (const revision of [edited.revision, done.revision, item.revision]) {
			const again = await complete(alice, { itemId: item.id }, revision);
			assert.deepEqual(again.body, { version: 1, outcome: "unchanged", message: "Already complete." });
		}
		assert.equal((await listItems(db, alice))[0].revision, done.revision);
		assert.equal(ready(await read(alice))[0].kind, "empty");

		// Two simultaneous posts of the same card: one applies, the other is unchanged.
		const next = await createItem(db, alice, value("Hire"));
		const outcomes = await Promise.all([
			complete(alice, { itemId: next.id }, next.revision),
			complete(alice, { itemId: next.id }, next.revision),
		]);
		assert.deepEqual(outcomes.map((v) => (v.body as { outcome: string }).outcome).sort(), ["applied", "unchanged"]);
		assert.equal((await listItems(db, alice)).find((v) => v.id === next.id)?.revision, next.revision + 1);
	} finally {
		client.close();
	}
});

test("an organization admin cannot complete another member's item, and cannot tell it exists", async () => {
	const { db, client, complete } = await setup();
	try {
		const item = await createItem(db, alice, value("Alice stone"));
		const foreign = await complete(admin, { itemId: item.id }, item.revision);
		const missing = await complete(admin, { itemId: crypto.randomUUID() }, 1);
		assert.equal(foreign.status, 404);
		assert.deepEqual(foreign, missing);
		// Also when it is already done: no `unchanged` answer reveals it.
		const otherInstallation = await complete(otherInstall, { itemId: item.id }, item.revision);
		assert.deepEqual(otherInstallation, missing);
		const [row] = await listItems(db, alice);
		assert.deepEqual({ status: row.status, revision: row.revision }, { status: "todo", revision: item.revision });
		await complete(alice, { itemId: item.id }, item.revision);
		assert.deepEqual(await complete(admin, { itemId: item.id }, item.revision + 1), missing);
	} finally {
		client.close();
	}
});

test("malformed actions and inputs are rejected without changes", async () => {
	const { db, client, call, complete } = await setup();
	try {
		const item = await createItem(db, alice, value("Launch"));
		for (const [input, revision] of [
			[{}, item.revision],
			[{ itemId: "not-a-uuid" }, item.revision],
			[{ itemId: item.id, extra: true }, item.revision],
			[[item.id], item.revision],
			[item.id, item.revision],
			[{ itemId: item.id }, undefined],
			[{ itemId: item.id }, 0],
			[{ itemId: item.id }, "1"],
			[{ itemId: item.id }, 1.5],
		] as const) {
			assert.equal((await complete(alice, input, revision)).status, 400, JSON.stringify([input, revision]));
		}
		const action = (body: unknown) => call("action", alice, body);
		assert.equal((await action({ cardId: "my-priorities", actionId: "delete-item", input: { itemId: item.id }, revision: 1 })).status, 404);
		assert.equal((await action({ cardId: "my-priorities", actionId: "complete-item", input: { itemId: item.id }, revision: 1, extra: 1 })).status, 400);
		assert.equal((await action({ cardId: "elsewhere", actionId: "complete-item", input: { itemId: item.id }, revision: 1 })).status, 404);
		assert.equal((await call("read", alice, { cardId: "my-priorities", size: "huge" })).status, 400);
		const [row] = await listItems(db, alice);
		assert.deepEqual({ status: row.status, revision: row.revision }, { status: "todo", revision: 1 });
	} finally {
		client.close();
	}
});

test("long titles and parents stay within card limits", async () => {
	const { db, client, read } = await setup();
	try {
		const stone = await createItem(db, alice, value("S".repeat(160)));
		await createItem(db, alice, value("P".repeat(160), "pebble", stone.id));
		const items = listOf(ready(await read(alice)));
		assert.equal(items[0].title.length, 120);
		assert.ok(items[0].title.endsWith("…"));
		assert.equal(items[1].subtitle, `Pebble · ${"S".repeat(160)}`);
	} finally {
		client.close();
	}
});


test("personal feed separates tasks and routines, keeps old suggestions, and reads without inference", async () => {
 const { db, client, call } = await setup();
 try {
  await createItem(db, personal, value("Small job", "sand"));
  const now = Date.now();
  const old = { id: crypto.randomUUID(), kind: "workflow", title: "Weekly review", why: "A recurring need", task: { title: "Review", description: "Review", cadence: "Weekly", steps: [] }, app: null, routineId: null, routineName: null, status: "open", createdAt: new Date(now).toISOString() };
  const task = { ...old, id: crypto.randomUUID(), kind: "task", title: "Send form", task: null, oneOffTask: { title: "Send form", description: "Prepare it" } };
  await db.insert(discoveryRecords).values({ id: crypto.randomUUID(), installationId: personal.installationId, ownerId: personal.userId, kind: "suggestions", data: JSON.stringify({ runId: "run-1", suggestions: [old, task] }), createdAt: now });
  const view = async (id: string) => { const result = await call("read", personal, { cardId: `feed-${id}`, size: "large" }); assert.equal(result.status, 200); return ready(homeCardReadResult.parse(result.body)); };
  assert.deepEqual(listOf(await view("all")).map((item) => item.title), ["Small job", "Weekly review", "Send form"]);
  assert.deepEqual(listOf(await view("quick-ones")).map((item) => item.title), ["Small job", "Send form"]);
  assert.deepEqual(listOf(await view("routines")).map((item) => item.title), ["Weekly review"]);
  assert.ok((await view("role")).some((node) => node.kind === "notice"));
  assert.equal((await call("read", otherInstall, { cardId: "feed-all", size: "large" })).status, 403);
 } finally { client.close(); }
});


test("role view uses the saved profile and exposes failed discovery", async () => {
 const calls: string[] = [];
 const host = { call: async (name: string) => { calls.push(name); return { work: { suspectedRole: { title: "Engineer" } } }; } } as unknown as ReturnType<NonNullable<Parameters<typeof homeCards>[1]>>;
 const { db, client, call } = await setup(() => host);
 try {
  const now = Date.now();
  const suggestion = { id: crypto.randomUUID(), kind: "app", title: "Review designs", why: "Design work", roleRelevance: { title: "Engineer", reason: "Supports design reviews" }, task: null, app: { name: "Reviews", goal: "Review" }, routineId: null, routineName: null, status: "open", createdAt: new Date(now).toISOString() };
  await db.insert(discoveryRecords).values([{ id: crypto.randomUUID(), installationId: personal.installationId, ownerId: personal.userId, kind: "suggestions", data: JSON.stringify({ runId: "run-1", suggestions: [suggestion] }), createdAt: now }, { id: crypto.randomUUID(), installationId: personal.installationId, ownerId: personal.userId, kind: "run", data: JSON.stringify({ id: "failed", status: "failed", startedAt: new Date(now).toISOString() }), createdAt: now + 1 }]);
  const result = await call("read", personal, { cardId: "feed-role", size: "large" });
  assert.equal(result.status, 200);
  const parsed = homeCardReadResult.parse(result.body);
  assert.equal(parsed.title, "For Engineer");
  const body = ready(parsed);
  assert.equal(listOf(body)[0].title, "Review designs");
  assert.ok(body.some((node) => node.kind === "notice" && node.tone === "warning"));
  assert.deepEqual(calls, ["profile.read"]);
 } finally { client.close(); }
});


test("feed preserves distinct records sharing a title and deduplicates repeated IDs", async () => {
 const { db, client, call } = await setup();
 try {
  await createItem(db, personal, value("Review invoices", "sand"));
  const now = Date.now();
  const suggestion = { id: crypto.randomUUID(), kind: "workflow", title: "Review invoices", why: "A recurring need", task: { title: "Review", description: "Review", cadence: "Weekly", steps: [] }, app: null, routineId: null, routineName: null, status: "open", createdAt: new Date(now).toISOString() };
  await db.insert(discoveryRecords).values({ id: crypto.randomUUID(), installationId: personal.installationId, ownerId: personal.userId, kind: "suggestions", data: JSON.stringify({ runId: "run-1", suggestions: [suggestion, suggestion] }), createdAt: now });
  const result = await call("read", personal, { cardId: "feed-all", size: "large" });
  const body = ready(homeCardReadResult.parse(result.body));
  assert.deepEqual(listOf(body).map((item) => item.title), ["Review invoices", "Review invoices"]);
 } finally { client.close(); }
});

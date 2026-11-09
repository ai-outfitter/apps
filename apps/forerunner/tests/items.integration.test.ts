import assert from "node:assert/strict";
import test from "node:test";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import {
	createItem,
	deleteItem,
	listItems,
	reorderItems,
	updateItem,
} from "../src/server/items";
import { fileURLToPath } from "node:url";

const alice: AppIdentity = {
	userId: "alice",
	installationId: "one",
	organizationId: "org",
	owner: { kind: "organization" as const, id: "org" },
	role: "member",
	canEdit: false,
};
const bob = { ...alice, userId: "bob", role: "owner", canEdit: true };
const other = { ...alice, installationId: "two" };
const value = (
	title: string,
	category = "stone",
	parentId: string | null = null,
) => ({
	title,
	category,
	parentId,
	description: "",
	dueDate: null,
	status: "todo",
});
const status = (code: number) => (e: unknown) =>
	e instanceof Response && e.status === code;
async function setup() {
	const client = createClient({ url: ":memory:" });
	const db = drizzle(client);
	await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
	return { db, client };
}

test("manual CRUD persists private issues and rejects stale writes", async () => {
	const { db, client } = await setup();
	try {
		assert.deepEqual(await listItems(db, alice), []);
		const stone = await createItem(db, alice, value("Launch"));
		assert.match(stone.id, /^[a-f0-9-]{36}$/);
		assert.equal(stone.revision, 1);
		const active = await updateItem(db, alice, stone.id, {
			...value("Launch edited"),
			status: "in-progress",
			dueDate: "2026-10-20",
			revision: 1,
		});
		assert.equal(active.status, "in-progress");
		assert.equal(active.revision, 2);
		await assert.rejects(
			updateItem(db, alice, stone.id, { ...value("Overwrite"), revision: 1 }),
			status(409),
		);
		await assert.rejects(
			deleteItem(db, alice, stone.id, { revision: 1 }),
			status(409),
		);
		const done = await updateItem(db, alice, stone.id, {
			...value("Launch edited"),
			status: "done",
			revision: 2,
		});
		assert.equal((await listItems(db, alice))[0].status, "done");
		const reopened = await updateItem(db, alice, stone.id, {
			...value("Launch edited"),
			revision: done.revision,
		});
		assert.equal(reopened.status, "todo");
		await deleteItem(db, alice, stone.id, { revision: reopened.revision });
		assert.deepEqual(await listItems(db, alice), []);
	} finally {
		client.close();
	}
});

test("members and installations cannot read, mutate or link each other's issues", async () => {
	const { db, client } = await setup();
	try {
		const stone = await createItem(db, alice, value("Private"));
		for (const who of [bob, other]) {
			assert.deepEqual(await listItems(db, who), []);
			await assert.rejects(
				updateItem(db, who, stone.id, { ...value("stolen"), revision: 1 }),
				status(404),
			);
			await assert.rejects(
				deleteItem(db, who, stone.id, { revision: 1 }),
				status(404),
			);
			await assert.rejects(
				createItem(db, who, value("linked", "pebble", stone.id)),
				status(400),
			);
			const own = await createItem(db, who, value("Own"));
			await assert.rejects(
				reorderItems(db, who, {
					items: [
						{ id: own.id, revision: 1 },
						{ id: stone.id, revision: 1 },
					],
				}),
				status(404),
			);
		}
		assert.equal((await listItems(db, alice)).length, 1);
	} finally {
		client.close();
	}
});

test("parent constraints survive direct SQL; children must move before stone deletion", async () => {
	const { db, client } = await setup();
	try {
		const stone = await createItem(db, alice, value("First"));
		const next = await createItem(db, alice, value("Next"));
		const pebble = await createItem(
			db,
			alice,
			value("Action", "pebble", stone.id),
		);
		const sand = await createItem(db, alice, value("Small", "sand", stone.id));
		await assert.rejects(
			createItem(db, alice, value("Orphan", "pebble")),
			status(400),
		);
		await assert.rejects(
			createItem(db, alice, value("Wrong parent", "sand", pebble.id)),
			status(400),
		);
		await assert.rejects(
			deleteItem(db, alice, stone.id, { revision: 1 }),
			status(409),
		);
		await assert.rejects(
			updateItem(db, alice, stone.id, {
				...value("Changed", "sand"),
				revision: 1,
			}),
			status(409),
		);
		await assert.rejects(
			client.execute({
				sql: "UPDATE forerunner_items SET parentId = ? WHERE id = ?",
				args: [pebble.id, sand.id],
			}),
			/forerunner_parent/,
		);
		await assert.rejects(
			client.execute({
				sql: "UPDATE forerunner_items SET ownerId = 'bob' WHERE id = ?",
				args: [stone.id],
			}),
			/forerunner_children/,
		);
		await updateItem(db, alice, pebble.id, {
			...value("Action", "pebble", next.id),
			revision: 1,
		});
		await updateItem(db, alice, sand.id, {
			...value("Small", "sand"),
			revision: 1,
		});
		await deleteItem(db, alice, stone.id, { revision: 1 });
		assert.equal((await listItems(db, alice)).length, 3);
	} finally {
		client.close();
	}
});

test("reorder atomically rejects stale, incomplete, duplicated or mixed-category orders", async () => {
	const { db, client } = await setup();
	try {
		const a = await createItem(db, alice, value("A"));
		const b = await createItem(db, alice, value("B"));
		const c = await createItem(db, alice, value("C"));
		const sand = await createItem(db, alice, value("Sand", "sand"));
		const refs = (rows: (typeof a)[]) =>
			rows.map(({ id, revision }) => ({ id, revision }));
		const reordered = await reorderItems(db, alice, { items: refs([c, a, b]) });
		assert.deepEqual(
			reordered.filter((v) => v.category === "stone").map((v) => v.title),
			["C", "A", "B"],
		);
		const before = await listItems(db, alice);
		await assert.rejects(
			reorderItems(db, alice, { items: refs([b, a, c]) }),
			status(409),
		);
		assert.deepEqual(await listItems(db, alice), before);
		await assert.rejects(
			reorderItems(db, alice, {
				items: refs(before.filter((v) => v.category === "stone").slice(0, 2)),
			}),
			status(409),
		);
		await assert.rejects(
			reorderItems(db, alice, { items: refs([sand, a]) }),
			status(400),
		);
		await assert.rejects(
			reorderItems(db, alice, { items: refs([a, a]) }),
			status(400),
		);
		await assert.rejects(
			createItem(db, alice, { ...value("Bad date"), dueDate: "2026-02-30" }),
			status(400),
		);
		await assert.rejects(
			createItem(db, alice, { ...value("   ") }),
			status(400),
		);
	} finally {
		client.close();
	}
});

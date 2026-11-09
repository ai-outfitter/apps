import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { items } from "./schema";

// Both D1 and libSQL implement this SQLite query interface.
// biome-ignore lint/suspicious/noExplicitAny: driver result types differ.
export type Database = BaseSQLiteDatabase<"async", any>;
const fields = z
	.object({
		category: z.enum(["stone", "pebble", "sand"]),
		title: z.string().trim().min(1).max(160),
		description: z.string().trim().max(4000).default(""),
		dueDate: z.iso.date().nullable().default(null),
		status: z.enum(["todo", "in-progress", "done"]).default("todo"),
		parentId: z.uuid().nullable().default(null),
	})
	.strict()
	.refine((v) =>
		v.category === "stone"
			? !v.parentId
			: v.category !== "pebble" || !!v.parentId,
	);
export const createInput = fields;
export const updateInput = fields.safeExtend({
	revision: z.number().int().positive(),
});
export const deleteInput = z
	.object({ revision: z.number().int().positive() })
	.strict();
export const reorderInput = z
	.object({
		items: z
			.array(
				z
					.object({ id: z.uuid(), revision: z.number().int().positive() })
					.strict(),
			)
			.min(2)
			.max(500),
	})
	.strict();
const scope = (who: AppIdentity) =>
	and(
		eq(items.ownerId, who.userId),
		eq(items.installationId, who.installationId),
	);
const missing = () => new Response("Item not found", { status: 404 });
const conflict = () =>
	new Response(
		"This board changed. Reload the board before trying again; your draft is kept.",
		{ status: 409 },
	);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (!result.success) throw new Response("Invalid item", { status: 400 });
	return result.data;
}
// The database triggers enforce these relationships atomically, including
// concurrent parent deletion/reclassification after the friendly precheck.
async function parent(
	db: Database,
	who: AppIdentity,
	value: z.infer<typeof fields>,
) {
	if (!value.parentId) return;
	const [row] = await db
		.select()
		.from(items)
		.where(
			and(
				scope(who),
				eq(items.id, value.parentId),
				eq(items.category, "stone"),
			),
		);
	if (!row) throw new Response("Choose one of your stones", { status: 400 });
}
async function guarded<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof Response) throw error;
		const message = `${error} ${error instanceof Error ? error.cause : ""}`;
		if (/forerunner_limit/.test(message))
			throw new Response(
				"Your board supports up to 500 items. Delete an item before adding another.",
				{ status: 409 },
			);
		if (
			/forerunner_parent|forerunner_children|FOREIGN KEY constraint/i.test(
				message,
			)
		)
			throw new Response(
				"Reassign or detach children before changing or deleting their stone. Pebbles require a stone.",
				{ status: 409 },
			);
		throw error;
	}
}
// One of the member's own items in this installation, or undefined: another
// member's item is indistinguishable from one that does not exist.
export async function findItem(db: Database, who: AppIdentity, id: string) {
	const [row] = await db
		.select()
		.from(items)
		.where(and(scope(who), eq(items.id, id)));
	return row;
}
export async function listItems(db: Database, who: AppIdentity) {
	return db
		.select()
		.from(items)
		.where(scope(who))
		.orderBy(asc(items.position), asc(items.createdAt), asc(items.id));
}
export async function createItem(
	db: Database,
	who: AppIdentity,
	input: unknown,
) {
	const value = parse(createInput, input);
	await parent(db, who, value);
	const now = Date.now();
	const [row] = await guarded(() =>
		db
			.insert(items)
			.values({
				...value,
				id: crypto.randomUUID(),
				ownerId: who.userId,
				installationId: who.installationId,
				createdAt: now,
				updatedAt: now,
				position: sql`(SELECT coalesce(max(position), 0) + 1 FROM forerunner_items WHERE ownerId = ${who.userId} AND installationId = ${who.installationId} AND category = ${value.category})`,
			})
			.returning(),
	);
	return row;
}
export async function updateItem(
	db: Database,
	who: AppIdentity,
	id: string,
	input: unknown,
) {
	const { revision, ...value } = parse(updateInput, input);
	const [existing] = await db
		.select()
		.from(items)
		.where(and(scope(who), eq(items.id, id)));
	if (!existing) throw missing();
	if (value.parentId === id)
		throw new Response("An item cannot parent itself", { status: 400 });
	await parent(db, who, value);
	const [row] = await guarded(() =>
		db
			.update(items)
			.set({
				...value,
				revision: sql`${items.revision} + 1`,
				updatedAt: Date.now(),
			})
			.where(and(scope(who), eq(items.id, id), eq(items.revision, revision)))
			.returning(),
	);
	if (!row) throw conflict();
	return row;
}
export async function deleteItem(
	db: Database,
	who: AppIdentity,
	id: string,
	input: unknown,
) {
	const { revision } = parse(deleteInput, input);
	const [existing] = await db
		.select()
		.from(items)
		.where(and(scope(who), eq(items.id, id)));
	if (!existing) throw missing();
	if (existing.revision !== revision) throw conflict();
	const rows = await guarded(() =>
		db
			.delete(items)
			.where(and(scope(who), eq(items.id, id), eq(items.revision, revision)))
			.returning({ id: items.id }),
	);
	if (!rows.length) throw conflict();
	return { deleted: id };
}
// Reorder a complete category, including completed items. One SQLite statement
// validates every revision before changing any position; no partial reorder.
export async function reorderItems(
	db: Database,
	who: AppIdentity,
	input: unknown,
) {
	const { items: order } = parse(reorderInput, input);
	const ids = order.map((v) => v.id);
	if (new Set(ids).size !== ids.length)
		throw new Response("Duplicate items", { status: 400 });
	const rows = await db
		.select()
		.from(items)
		.where(and(scope(who), inArray(items.id, ids)));
	if (rows.length !== ids.length) throw missing();
	const category = rows[0].category;
	if (rows.some((v) => v.category !== category))
		throw new Response("Reorder one category at a time", { status: 400 });
	const matches = sql.join(
		order.map((v) => sql`(id = ${v.id} AND revision = ${v.revision})`),
		sql` OR `,
	);
	const positions = sql.join(
		order.map((v, i) => sql`WHEN ${v.id} THEN ${i + 1}`),
		sql` `,
	);
	const changed = await db
		.update(items)
		.set({
			position: sql`CASE ${items.id} ${positions} END`,
			revision: sql`${items.revision} + 1`,
			updatedAt: Date.now(),
		})
		.where(
			and(
				scope(who),
				eq(items.category, category),
				sql`(SELECT count(*) FROM forerunner_items WHERE installationId = ${who.installationId} AND ownerId = ${who.userId} AND category = ${category}) = ${order.length}`,
				sql`(SELECT count(*) FROM forerunner_items WHERE installationId = ${who.installationId} AND ownerId = ${who.userId} AND (${matches})) = ${order.length}`,
			),
		)
		.returning();
	if (changed.length !== order.length) throw conflict();
	return listItems(db, who);
}

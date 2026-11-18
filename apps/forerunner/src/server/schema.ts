export { graphChangeReceipts } from "@ai-outfitter/app-sdk/batch-receipts";
import {
	type AnySQLiteColumn,
	index,
	integer,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

export const items = sqliteTable(
	"forerunner_items",
	{
		id: text().primaryKey(),
		installationId: text().notNull(),
		ownerId: text().notNull(),
		category: text({ enum: ["stone", "pebble", "sand"] }).notNull(),
		title: text().notNull(),
		description: text().notNull().default(""),
		dueDate: text(),
		status: text({ enum: ["todo", "in-progress", "done"] })
			.notNull()
			.default("todo"),
		position: integer().notNull(),
		parentId: text().references((): AnySQLiteColumn => items.id, {
			onDelete: "restrict",
		}),
		revision: integer().notNull().default(1),
		createdAt: integer().notNull(),
		updatedAt: integer().notNull(),
	},
	(t) => [
		index("forerunner_owner_order").on(
			t.installationId,
			t.ownerId,
			t.category,
			t.position,
		),
		index("forerunner_parent").on(t.parentId),
	],
);
export type Item = typeof items.$inferSelect;

// Private source samples and exact, reviewable graph proposals. Never a second Wiki.
export const discoveryRecords = sqliteTable(
  "forerunner_discovery_records",
  {
    id: text().primaryKey(),
    installationId: text().notNull(),
    ownerId: text().notNull(),
    kind: text({ enum: ["sample", "preview", "run", "suggestions", "role-snapshot", "suggestion-status"] }).notNull(),
    data: text().notNull(),
    createdAt: integer().notNull(),
  },
  (t) => [
    index("forerunner_discovery_owner").on(t.installationId, t.ownerId, t.kind),
  ],
);


// Captured only on a real transition to done; edits, reopening and deletion do not rewrite history.
export const itemCompletions = sqliteTable("forerunner_item_completions", {
  id: text().primaryKey(), installationId: text().notNull(), ownerId: text().notNull(), itemId: text().notNull(),
  title: text().notNull(), category: text().notNull(), revision: integer().notNull(), completedAt: integer().notNull(),
}, table => [index("forerunner_completions_owner_date").on(table.installationId, table.ownerId, table.completedAt)]);

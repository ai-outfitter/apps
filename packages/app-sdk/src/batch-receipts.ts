import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
/** Transport receipts live in the same installation database as their app's writes. */
export const graphChangeReceipts = sqliteTable("graph_change_receipts", {
  actor:text().notNull(), document:text().notNull(), requestKey:text("request_key").notNull(), fingerprint:text().notNull(),
  claim:text().notNull(), result:text(), createdAt:integer("created_at").notNull(),
}, row=>[primaryKey({columns:[row.actor,row.document,row.requestKey]})]);

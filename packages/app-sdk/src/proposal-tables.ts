import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/sqlite-core";
/** App-local review state only. Conversation content and reply leases belong to shared threads. */
export function proposalTables(table: string, guardName: string) {
  for (const name of [table, guardName])
    if (!/^[a-z][a-z0-9_]*$/.test(name))
      throw new Error("Invalid proposal table name");
  const proposals = sqliteTable(
    table,
    {
      id: text().primaryKey(),
      installationId: text().notNull(),
      ownerId: text().notNull(),
      threadId: text().notNull(),
      turnId: text(),
      requestKey: text().notNull(),
      payloadDigest: text().notNull(),
      action: text().notNull(),
      projectId: text(),
      revision: integer().notNull().default(1),
      status: text({
        enum: ["pending", "applied", "rejected", "cancelled", "uncertain"],
      })
        .notNull()
        .default("pending"),
      data: text().notNull(),
      receipt: text(),
      decidedBy: text(),
      timelineEntryId: text(),
      createdAt: integer(),
      updatedAt: integer(),
    },
    (t) => [
      uniqueIndex(`${table}_request`).on(t.installationId, t.requestKey),
      index(`${table}_thread`).on(t.installationId, t.threadId),
      index(`${table}_owner`).on(t.installationId, t.ownerId, t.status),
    ],
  );
  const guard = sqliteTable(guardName, { value: integer().notNull() }, (t) => [
    check(guardName.replace(/_guard$/, "_atomic"), sql`${t.value}=1`),
  ]);
  return { proposals, guard };
}

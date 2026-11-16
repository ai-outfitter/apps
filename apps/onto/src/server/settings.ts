import { type AppIdentity, requireAccess } from "@ai-outfitter/app-sdk/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./graph-batches";
import { ontoSettings } from "./schema";

// Onto's own settings, changed by an admin of the installation. `stewardApproval` says what
// happens after the ontology steward reviews a submitted batch: `approve` (the default) lets
// it approve what it found clean, `review` leaves every decision to a member.

export const stewardApprovalModes = ["approve", "review"] as const;
export type StewardApproval = (typeof stewardApprovalModes)[number];
export const settingsInput = z.strictObject({
  stewardApproval: z.enum(stewardApprovalModes)
    .describe("approve: after its review the steward approves every proposal it found clean, and the rest waits for a member. review: the steward only reviews; a member decides everything."),
});
export type OntoSettings = z.infer<typeof settingsInput> & { updatedAt: number | null; updatedBy: string | null };

const key = "steward-approval";

export async function readSettings(db: Database): Promise<OntoSettings> {
  const [row] = await db.select().from(ontoSettings).where(eq(ontoSettings.key, key));
  const parsed = row ? settingsInput.shape.stewardApproval.safeParse(row.value) : null;
  return { stewardApproval: parsed?.success ? parsed.data : "approve", updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
}

export async function saveSettings(db: Database, who: AppIdentity, input: z.infer<typeof settingsInput>) {
  requireAccess(who, "admin");
  if (who.entityWriter) throw new Response("Only an admin changes Onto's settings", { status: 403 });
  const now = Date.now();
  await db.insert(ontoSettings).values({ key, value: input.stewardApproval, updatedAt: now, updatedBy: who.userId })
    .onConflictDoUpdate({ target: ontoSettings.key, set: { value: input.stewardApproval, updatedAt: now, updatedBy: who.userId } });
  return readSettings(db);
}

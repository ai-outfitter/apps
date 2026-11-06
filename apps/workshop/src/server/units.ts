import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkshopDatabase } from "./projects";
import { workshopUnits } from "./schema";

export const UNIT_LIMIT = 1000;

/** Accepts AA:BB:CC:DD:EE:FF, aa-bb-..., or 12 hex digits; stores AA:BB:CC:DD:EE:FF. */
export const macAddress = z
  .string()
  .trim()
  .transform((value) => value.replace(/[:-]/g, "").toUpperCase())
  .refine((value) => /^[0-9A-F]{12}$/.test(value), "Use a MAC address such as 34:85:18:AA:BB:CC")
  .transform((value) => value.match(/../g)?.join(":") ?? value);

export const UnitInput = z
  .object({
    partNumber: z.string().trim().min(1).max(60),
    mpn: z.string().trim().max(100).default(""),
    mac: macAddress.optional(),
    serial: z.string().trim().min(1).max(100).optional(),
    status: z.enum(["in-stock", "allocated", "installed", "retired"]).default("in-stock"),
    location: z.string().trim().max(100).default(""),
    projectId: z.uuid().nullable().default(null),
    firmware: z.string().trim().max(100).default(""),
    notes: z.string().max(2000).default(""),
  })
  .strict()
  .refine((unit) => unit.mac || unit.serial, "Give a MAC address or a serial number");

export type Unit = typeof workshopUnits.$inferSelect;

export function listWorkshopUnits(db: WorkshopDatabase) {
  return db
    .select()
    .from(workshopUnits)
    .orderBy(asc(workshopUnits.partNumber), asc(workshopUnits.createdAt), asc(workshopUnits.id))
    .limit(UNIT_LIMIT);
}

const taken = (mac: string) =>
  new Response(`A unit with MAC address ${mac} is already in inventory.`, { status: 409 });

async function macOwner(db: WorkshopDatabase, mac: string | undefined) {
  if (!mac) return undefined;
  const [row] = await db.select({ id: workshopUnits.id }).from(workshopUnits).where(eq(workshopUnits.mac, mac));
  return row?.id;
}

/** Records one physical unit (the RecordWorkshopUnit mutation): a part number with a MAC address or serial. */
export async function createWorkshopUnit(db: WorkshopDatabase, identity: AppIdentity, input: z.infer<typeof UnitInput>) {
  if (input.mac && (await macOwner(db, input.mac))) throw taken(input.mac);
  const now = new Date().toISOString();
  const unit: Unit = {
    id: crypto.randomUUID(),
    ...input,
    mac: input.mac ?? null,
    serial: input.serial ?? null,
    revision: 1,
    createdBy: identity.userId,
    updatedBy: identity.userId,
    createdAt: now,
    updatedAt: now,
  };
  // One statement keeps the cap atomic.
  await db.run(sql`INSERT INTO workshop_units (id, partNumber, mpn, mac, serial, status, location, projectId, firmware, notes, revision, createdBy, updatedBy, createdAt, updatedAt)
    SELECT ${unit.id}, ${unit.partNumber}, ${unit.mpn}, ${unit.mac}, ${unit.serial}, ${unit.status}, ${unit.location}, ${unit.projectId}, ${unit.firmware}, ${unit.notes}, 1, ${unit.createdBy}, ${unit.updatedBy}, ${now}, ${now}
    WHERE (SELECT count(*) FROM workshop_units) < ${UNIT_LIMIT}`);
  const [row] = await db.select({ id: workshopUnits.id }).from(workshopUnits).where(eq(workshopUnits.id, unit.id));
  if (!row)
    throw new Response(`Workshop holds up to ${UNIT_LIMIT} units. Retire and delete old units first.`, { status: 409 });
  return unit;
}

/** The UpdateWorkshopUnit mutation's input: the whole unit again, at the revision the caller saw. */
export const UnitUpdate = z.object({ id: z.uuid(), revision: z.number().int().positive(), unit: UnitInput }).strict();
/** The DeleteWorkshopUnit mutation's input. */
export const UnitDelete = z.object({ id: z.uuid(), revision: z.number().int().positive() }).strict();

/** Replaces a unit's fields (flashing, installing, moving it) at the revision the caller saw. */
export async function updateWorkshopUnit(db: WorkshopDatabase, identity: AppIdentity, { id, revision, unit }: z.infer<typeof UnitUpdate>) {
  const owner = await macOwner(db, unit.mac);
  if (unit.mac && owner && owner !== id) throw taken(unit.mac);
  const [updated] = await db
    .update(workshopUnits)
    .set({
      ...unit,
      mac: unit.mac ?? null,
      serial: unit.serial ?? null,
      revision: revision + 1,
      updatedBy: identity.userId,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(workshopUnits.id, id), eq(workshopUnits.revision, revision)))
    .returning();
  if (!updated) throw new Response("Unit changed in another session, or was deleted. Reload first.", { status: 409 });
  return updated;
}

/** Removes a unit from inventory at the revision the caller saw. */
export async function deleteWorkshopUnit(db: WorkshopDatabase, { id, revision }: z.infer<typeof UnitDelete>) {
  const [deleted] = await db
    .delete(workshopUnits)
    .where(and(eq(workshopUnits.id, id), eq(workshopUnits.revision, revision)))
    .returning({ id: workshopUnits.id });
  if (!deleted) throw new Response("Unit changed in another session, or was deleted. Reload first.", { status: 409 });
  return { id };
}

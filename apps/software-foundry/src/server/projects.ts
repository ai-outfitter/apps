import { and, asc, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import {
  type AppIdentity,
  isUniqueViolation,
  readJSON,
  requireEditor,
} from "@ai-outfitter/app-sdk/server";
import { milestoneKey } from "./ranking";
import { foundryProjects } from "./schema";

// biome-ignore lint/suspicious/noExplicitAny: D1 and libSQL drivers differ only in their result type.
export type FoundryDatabase = BaseSQLiteDatabase<"async", any>;
type Row = typeof foundryProjects.$inferSelect;

// Software Foundry projects: named groups of repositories, ordered by
// priority, each ranking its milestones by title, most important first.
// People edit them in Foundry; agents use the same endpoints. Members read;
// owners and admins write; every write names the revision it read. The
// platform applies the organization's available repositories when it reads.
export const PROJECT_LIMIT = 50;
export const PROJECT_REPOSITORY_LIMIT = 20;
const RANKED_MILESTONE_LIMIT = 200;

const name = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/)
  .transform((value) => value.toUpperCase().replace(/\s+/g, " "));
/** An `owner/name` GitHub repository as typed; `repository` is its lower-case form, as connections store it. */
export const repositoryName = z.string().max(140).regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
export const repository = repositoryName.transform((value) => value.toLowerCase());
const repositories = z
  .array(repository)
  .max(PROJECT_REPOSITORY_LIMIT)
  .transform((values) => [...new Set(values)]);
const milestones = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(255)
      .transform((title) => milestoneKey(title)),
  )
  .max(RANKED_MILESTONE_LIMIT)
  .refine((keys) => new Set(keys).size === keys.length);
const revision = z.number().int().positive();

/** A new project, as the projects page posts it and the createProject mutation takes it. */
export const createProjectInput = z
  .object({ name, repositories: repositories.default([]) })
  .strict();
const updateInput = z
  .object({
    name: name.optional(),
    repositories: repositories.optional(),
    milestones: milestones.optional(),
    revision,
  })
  .strict();
const deleteInput = z.object({ revision }).strict();
const orderInput = z
  .object({ ids: z.array(z.uuid()).max(PROJECT_LIMIT) })
  .strict();

export function publicProject(row: Row) {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    repositories: row.repositories,
    milestones: row.milestones,
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}
export type FoundryProject = ReturnType<typeof publicProject>;

/** The projects, highest priority first. */
async function stored(db: FoundryDatabase) {
  const rows = await db
    .select()
    .from(foundryProjects)
    .orderBy(asc(foundryProjects.position), asc(foundryProjects.createdAt));
  return rows.map(publicProject);
}

/** One project as GET serves it (publicProject), or a 404. */
export async function readProject(db: FoundryDatabase, id: string) {
  return publicProject(await one(db, id));
}

async function one(db: FoundryDatabase, id: string) {
  if (!z.uuid().safeParse(id).success)
    throw new Response("Project not found", { status: 404 });
  const [row] = await db
    .select()
    .from(foundryProjects)
    .where(eq(foundryProjects.id, id));
  if (!row) throw new Response("Project not found", { status: 404 });
  return row;
}

function nameTaken(error: unknown): never {
  if (isUniqueViolation(error))
    throw new Response("A project with this name already exists.", {
      status: 409,
    });
  throw error;
}

// Positions follow `ids`, highest priority first; at most PROJECT_LIMIT rows.
async function renumber(
  db: FoundryDatabase,
  identity: AppIdentity,
  ids: string[],
) {
  const now = Date.now();
  for (const [position, id] of ids.entries())
    await db
      .update(foundryProjects)
      .set({ position, updatedBy: identity.userId, updatedAt: now })
      .where(eq(foundryProjects.id, id));
}

export async function listProjects(db: FoundryDatabase, identity: AppIdentity) {
  return { projects: await stored(db), canEdit: identity.canEdit };
}

/** Owners and admins add a project; the projects page and agents both reach this
 * through the CreateProject document (src/server/documents.ts). */
export async function createProject(
  db: FoundryDatabase,
  identity: AppIdentity,
  input: z.output<typeof createProjectInput>,
) {
  requireEditor(identity);
  const existing = await stored(db);
  if (existing.length >= PROJECT_LIMIT)
    throw new Response(`At most ${PROJECT_LIMIT} projects.`, { status: 400 });
  const now = Date.now();
  const id = crypto.randomUUID();
  await db
    .insert(foundryProjects)
    .values({
      id,
      name: input.name,
      position: existing.length,
      repositories: input.repositories,
      milestones: [],
      createdBy: identity.userId,
      updatedBy: identity.userId,
      createdAt: now,
      updatedAt: now,
    })
    .catch(nameTaken);
  return publicProject(await one(db, id));
}

/**
 * Rename a project, change its repositories or replace its milestone ranking:
 * milestone titles, most important first.
 */
export async function updateProject(
  db: FoundryDatabase,
  identity: AppIdentity,
  id: string,
  request: Request,
) {
  requireEditor(identity);
  const current = await one(db, id);
  const input = await readJSON(request, updateInput, 32_768);
  const updated = await db
    .update(foundryProjects)
    .set({
      ...(input.name ? { name: input.name } : {}),
      repositories: input.repositories ?? current.repositories,
      milestones: input.milestones ?? current.milestones,
      revision: input.revision + 1,
      updatedBy: identity.userId,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(foundryProjects.id, id),
        eq(foundryProjects.revision, input.revision),
      ),
    )
    .returning()
    .catch(nameTaken);
  if (!updated.length)
    throw new Response("Project changed. Reload before saving.", {
      status: 409,
    });
  return publicProject(updated[0]);
}

export async function deleteProject(
  db: FoundryDatabase,
  identity: AppIdentity,
  id: string,
  request: Request,
) {
  requireEditor(identity);
  await one(db, id);
  const input = await readJSON(request, deleteInput, 1024);
  const deleted = await db
    .delete(foundryProjects)
    .where(
      and(
        eq(foundryProjects.id, id),
        eq(foundryProjects.revision, input.revision),
      ),
    )
    .returning({ id: foundryProjects.id });
  if (!deleted.length)
    throw new Response("Project changed. Reload before deleting.", {
      status: 409,
    });
  // Close the gap so priorities stay 0..n-1.
  await renumber(
    db,
    identity,
    (await stored(db)).map((project) => project.id),
  );
  return { deleted: id };
}

/** Set project priority: `ids` lists every project, highest priority first. */
export async function orderProjects(
  db: FoundryDatabase,
  identity: AppIdentity,
  request: Request,
) {
  requireEditor(identity);
  const { ids } = await readJSON(request, orderInput, 4096);
  const known = (await stored(db)).map((project) => project.id).sort();
  if (ids.length !== known.length || [...ids].sort().join() !== known.join())
    throw new Response("List every project exactly once. Reload and retry.", {
      status: 409,
    });
  await renumber(db, identity, ids);
  return { projects: await stored(db) };
}

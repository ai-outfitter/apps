import { and, desc, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { projectPackage } from "../lib/package";
import { AssemblySchema } from "../lib/assembly";
import { EXAMPLES, makeProject, type Project, ProjectSchema } from "../lib/project";
import { workshopProjects } from "./schema";

/** The product revision columns, copied from the project document. */
const revisionColumns = ({ productRevision: r }: Project) => ({
  wikiInstallationId: r?.wikiInstallationId ?? null,
  productRevisionId: r?.id ?? null,
  productRevisionTitle: r?.title || null,
});

// biome-ignore lint/suspicious/noExplicitAny: D1 and libSQL drivers differ only in their result type.
export type WorkshopDatabase = BaseSQLiteDatabase<"async", any>;

export const PROJECT_LIMIT = 100;
const full = `Workshop holds up to ${PROJECT_LIMIT} projects. Export and delete an older project before creating another.`;

/** The Wiki ProductRevision a project builds, as a document names it: its record id, the
 * Wiki installation when known, its title and, when the caller has it, its link. */
const productRevisionInput = z
  .object({
    id: z.uuid(),
    wikiInstallationId: ProjectSchema.shape.productRevision.unwrap().shape.wikiInstallationId,
    title: ProjectSchema.shape.productRevision.unwrap().shape.title,
    url: ProjectSchema.shape.productRevision.unwrap().shape.url.default(""),
  })
  .strict();
/** A starter example to begin from: the CreateWorkshopProject mutation's input. The name
 * and the product revision are optional, so Planning starts a linked project in one write. */
export const exampleInput = z
  .object({
    example: z.enum(Object.keys(EXAMPLES) as (keyof typeof EXAMPLES)[]),
    name: ProjectSchema.shape.name.optional(),
    productRevision: productRevisionInput.optional(),
  })
  .strict();
// What the projects route takes: a starter example, or a whole first-revision
// project (an import, or a client that built the project itself).
export const createInput = z.union([exampleInput, z.object({ project: ProjectSchema }).strict()]);
/** The project at the revision the caller saw, which every patching mutation takes.
 * Any text as the id: a malformed one is a project that is not found (404), as on the page. */
const atRevision = { id: z.string().min(1).max(64), revision: z.number().int().nonnegative() };
/** The DeleteWorkshopProject mutation's input. */
export const deleteInput = z.object(atRevision).strict();
/** The NameWorkshopProductRevision mutation's input: null unlinks the project. */
export const linkInput = z.object({ ...atRevision, productRevision: productRevisionInput.nullable() }).strict();
/** The DescribeWorkshopProject mutation's input: the words and stage a project carries; a field left out keeps its value. */
export const describeInput = z
  .object({
    ...atRevision,
    name: ProjectSchema.shape.name.optional(),
    phase: ProjectSchema.shape.phase.unwrap().optional(),
    brief: ProjectSchema.shape.brief.optional(),
    requirements: ProjectSchema.shape.requirements.optional(),
  })
  .strict();
/** The SaveWorkshopAssembly mutation's input: the whole product structure (items and usage lines). */
export const assemblyInput = z.object({ ...atRevision, assembly: AssemblySchema }).strict();

/** The starter project an example makes, named and linked as the caller asked. */
export function projectFrom({ example, name, productRevision }: z.output<typeof exampleInput>): Project {
  const project = makeProject(example);
  return { ...project, ...(name ? { name } : {}), ...(productRevision ? { productRevision } : {}) };
}

export async function listWorkshopProjects(db: WorkshopDatabase) {
  const rows = await db
    .select({
      id: workshopProjects.id,
      name: workshopProjects.name,
      revision: workshopProjects.revision,
      updatedAt: workshopProjects.updatedAt,
      // Stored projects saved before stages existed have none: they are concepts.
      phase: sql<string>`coalesce(json_extract(${workshopProjects.data}, '$.phase'), 'concept')`,
    })
    .from(workshopProjects)
    .orderBy(desc(workshopProjects.updatedAt), workshopProjects.id)
    .limit(PROJECT_LIMIT);
  return rows.reverse();
}

/** One project's row, as the list and graph.graphql serve it, or a 404. */
export async function workshopProjectRow(db: WorkshopDatabase, id: string) {
  if (!z.uuid().safeParse(id).success)
    throw new Response("Not found", { status: 404 });
  const [row] = await db
    .select()
    .from(workshopProjects)
    .where(eq(workshopProjects.id, id));
  if (!row) throw new Response("Not found", { status: 404 });
  return row;
}

export async function getWorkshopProject(db: WorkshopDatabase, id: string) {
  return ProjectSchema.parse(JSON.parse((await workshopProjectRow(db, id)).data));
}

/** Stores `project` as its first revision, within the installation's cap. */
export async function createWorkshopProject(
  db: WorkshopDatabase,
  identity: AppIdentity,
  input: Project,
) {
  const project: Project = { ...input, revision: 1 };
  const exists = async () =>
    (
      await db
        .select({ id: workshopProjects.id })
        .from(workshopProjects)
        .where(eq(workshopProjects.id, project.id))
    ).length > 0;
  if (await exists())
    throw new Response("Project already exists.", { status: 409 });
  const linked = revisionColumns(project);
  // One statement keeps the cap atomic.
  await db.run(sql`INSERT INTO workshop_projects (id, name, revision, data, wikiInstallationId, productRevisionId, productRevisionTitle, createdBy, updatedBy, createdAt, updatedAt)
    SELECT ${project.id}, ${project.name}, ${project.revision}, ${JSON.stringify(project)}, ${linked.wikiInstallationId}, ${linked.productRevisionId}, ${linked.productRevisionTitle}, ${identity.userId}, ${identity.userId}, ${project.createdAt}, ${project.updatedAt}
    WHERE (SELECT count(*) FROM workshop_projects) < ${PROJECT_LIMIT}`);
  if (!(await exists())) throw new Response(full, { status: 409 });
  return project;
}

/** Replaces a project with `input`, the whole document at the revision the
 * caller saw. A project may be far larger than a document's variables, so this
 * stays the PUT route's own call rather than a mutation. */
export async function updateWorkshopProject(
  db: WorkshopDatabase,
  identity: AppIdentity,
  input: Project,
  id: string,
) {
  const previous = await workshopProjectRow(db, id);
  if (input.id !== id)
    throw new Response("Project ID mismatch", { status: 400 });
  const parsed = ProjectSchema.safeParse({
    ...input,
    createdAt: previous.createdAt,
    revision: input.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  if (!parsed.success)
    throw new Response(
      "Project exceeds the storage limit after saving. Shorten notes before retrying.",
      { status: 400 },
    );
  const next = parsed.data;
  const [updated] = await db
    .update(workshopProjects)
    .set({
      name: next.name,
      revision: next.revision,
      data: JSON.stringify(next),
      ...revisionColumns(next),
      updatedBy: identity.userId,
      updatedAt: next.updatedAt,
    })
    .where(
      and(
        eq(workshopProjects.id, id),
        eq(workshopProjects.revision, input.revision),
      ),
    )
    .returning({ id: workshopProjects.id });
  if (!updated)
    throw new Response(
      "Project changed in another session. Reload before saving.",
      { status: 409 },
    );
  return next;
}

/** Saves part of a project as its next revision: the project at the revision the caller saw,
 * with `patch` applied, parsed whole so the document's limits still hold. 404 when the
 * project is missing; 409 when another session saved first. */
export async function patchWorkshopProject(
  db: WorkshopDatabase,
  identity: AppIdentity,
  { id, revision }: { id: string; revision: number },
  patch: (current: Project) => Partial<Project>,
) {
  const current = await getWorkshopProject(db, id);
  if (current.revision !== revision)
    throw new Response("Project changed in another session. Reload before saving.", { status: 409 });
  const parsed = ProjectSchema.safeParse({
    ...current,
    ...patch(current),
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  if (!parsed.success)
    throw new Response(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "project"}: ${issue.message}`).join("; "),
      { status: 400 },
    );
  const next = parsed.data;
  const [updated] = await db
    .update(workshopProjects)
    .set({
      name: next.name,
      revision: next.revision,
      data: JSON.stringify(next),
      ...revisionColumns(next),
      updatedBy: identity.userId,
      updatedAt: next.updatedAt,
    })
    .where(and(eq(workshopProjects.id, id), eq(workshopProjects.revision, revision)))
    .returning({ id: workshopProjects.id });
  if (!updated)
    throw new Response("Project changed in another session. Reload before saving.", { status: 409 });
  return next;
}

/** Links a project to the Wiki ProductRevision it builds, or unlinks it (null). */
export function nameWorkshopProductRevision(db: WorkshopDatabase, identity: AppIdentity, input: z.output<typeof linkInput>) {
  return patchWorkshopProject(db, identity, input, () => ({ productRevision: input.productRevision ?? undefined }));
}

/** Sets the words and stage a project carries; fields left out keep their value. */
export function describeWorkshopProject(db: WorkshopDatabase, identity: AppIdentity, { id, revision, ...fields }: z.output<typeof describeInput>) {
  const given = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  return patchWorkshopProject(db, identity, { id, revision }, () => given);
}

/** Replaces a project's product structure: its items and the usage lines between them. */
export function saveWorkshopAssembly(db: WorkshopDatabase, identity: AppIdentity, { id, revision, assembly }: z.output<typeof assemblyInput>) {
  return patchWorkshopProject(db, identity, { id, revision }, () => ({ assembly }));
}

export async function exportWorkshopProject(db: WorkshopDatabase, id: string) {
  const project = await getWorkshopProject(db, id);
  return new Response(new Uint8Array(projectPackage(project)).buffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="workshop-${project.id}-r${project.revision}.zip"`,
    },
  });
}

/** Deletes a project at the revision the caller saw; answers its id. */
export async function deleteWorkshopProject(
  db: WorkshopDatabase,
  { id, revision }: z.output<typeof deleteInput>,
) {
  await workshopProjectRow(db, id);
  const [deleted] = await db
    .delete(workshopProjects)
    .where(
      and(
        eq(workshopProjects.id, id),
        eq(workshopProjects.revision, revision),
      ),
    )
    .returning({ id: workshopProjects.id });
  if (!deleted)
    throw new Response(
      "Project changed in another session. Reload before deleting.",
      { status: 409 },
    );
  return id;
}

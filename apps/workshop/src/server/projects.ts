import { and, desc, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { resolvedProject, assemblyGuard, noConsumers } from "./assembly-references";
import { projectPackage } from "../lib/package";
import { attachedMesh, filePath } from "../lib/assembly-file";
import { AssemblySchema, type Assembly } from "../lib/assembly";
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
    purpose: ProjectSchema.shape.purpose.unwrap().optional(),
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
    purpose: ProjectSchema.shape.purpose.unwrap().optional(),
    phase: ProjectSchema.shape.phase.unwrap().optional(),
    brief: ProjectSchema.shape.brief.optional(),
    requirements: ProjectSchema.shape.requirements.optional(),
  })
  .strict();
export const assemblyUpdateBody = z.strictObject({ expectedRevision: z.int32().nonnegative(), assembly: AssemblySchema });
/** The legacy SaveWorkshopAssembly input, also used by AssemblyChanges. */
export const assemblyInput = z.object({ ...atRevision, assembly: AssemblySchema }).strict();

/** The starter project an example makes, named and linked as the caller asked. */
export function projectFrom({ example, name, purpose, productRevision }: z.output<typeof exampleInput>): Project {
  const project = makeProject(example);
  return { ...project, ...(purpose ? { purpose } : {}), ...(name ? { name } : {}), ...(productRevision ? { productRevision } : {}) };
}

export async function listWorkshopProjects(db: WorkshopDatabase) {
  const rows = await db
    .select({
      id: workshopProjects.id,
      name: workshopProjects.name,
      purpose: workshopProjects.purpose,
      revision: workshopProjects.revision,
      updatedAt: workshopProjects.updatedAt,
      brief: sql<string>`substr(trim(coalesce(nullif(trim(json_extract(${workshopProjects.data}, '$.brief')), ''), json_extract(${workshopProjects.data}, '$.requirements'), '')), 1, 200)`,
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

export async function projectBySlugId(db: WorkshopDatabase, suffix: string) {
  const [row] = await db.select({data: workshopProjects.data}).from(workshopProjects)
    .where(sql`substr(${workshopProjects.id}, -12) = ${suffix}`).limit(1);
  return row && ProjectSchema.parse(JSON.parse(row.data));
}

export async function getWorkshopProject(db: WorkshopDatabase, id: string) {
  return ProjectSchema.parse(JSON.parse((await workshopProjectRow(db,id)).data));
}

/** Ordinary assembly edits can keep or remove receipts. Only a verified upload adds one. */
function checkSavedFiles(next: Assembly, previous?: Assembly) {
  const byId = new Map(previous?.items.map(item => [item.id, item]));
  for (const item of next.items) {
    const old = byId.get(item.id);
    if (item.cotsEvidence && (item.revision !== old?.revision || item.mpn !== old.mpn || item.manufacturer !== old.manufacturer ||
        JSON.stringify(item.cotsEvidence) !== JSON.stringify(old.cotsEvidence)))
      throw new Response("Record purchased-part evidence with RecordWorkshopCotsEvidence", {status:400});
    for (const file of item.files ?? []) {
      if (!old?.files?.some(saved => saved.projectId === file.projectId && saved.bytes === file.bytes && filePath(saved) === filePath(file)))
        throw new Response("Attach new files with UploadWorkshopAssemblyFile", {status:400});
    }
    if (old && attachedMesh(old) && item.mesh?.path === old.mesh?.path && !attachedMesh(item))
      throw new Response("Remove the mesh binding when removing its STL attachment", {status:400});
  }
}

/** Stores `project` as its first revision, within the installation's cap. */
export async function createWorkshopProject(
  db: WorkshopDatabase,
  identity: AppIdentity,
  input: Project,
) {
  if (input.workspace) throw new Response("Import model source, not workspace execution records", {status:400});
  if (input.pcbSnapshots?.length) throw new Response("Import PCB evidence through the snapshot API", {status:400});
  if (input.printPackages?.length) throw new Response("Import sliced evidence through the print plate operation", {status:400});
  checkSavedFiles(input.assembly);
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
  const guard = project.assembly.items.some(i=>i.reference || i.operations?.length) ? await assemblyGuard(db,project) : sql`1`;
  // One statement keeps the cap atomic.
  await db.run(sql`INSERT INTO workshop_projects (id, name, purpose, revision, data, wikiInstallationId, productRevisionId, productRevisionTitle, createdBy, updatedBy, createdAt, updatedAt)
    SELECT ${project.id}, ${project.name}, ${project.purpose}, ${project.revision}, ${JSON.stringify(project)}, ${linked.wikiInstallationId}, ${linked.productRevisionId}, ${linked.productRevisionTitle}, ${identity.userId}, ${identity.userId}, ${project.createdAt}, ${project.updatedAt}
    WHERE (SELECT count(*) FROM workshop_projects) < ${PROJECT_LIMIT} AND ${guard}`);
  if (!(await exists())) throw new Response(project.assembly.items.some(i=>i.reference) ? "Project limit reached or a reference changed. Reload before creating." : full, { status: 409 });
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
  workspaceWrite = false,
) {
  const previous = await workshopProjectRow(db, id);
  if (input.id !== id)
    throw new Response("Project ID mismatch", { status: 400 });
  if (!workspaceWrite) {
    const stored = ProjectSchema.parse(JSON.parse(previous.data));
    if(stored.revision !== input.revision) throw new Response("Project changed in another session. Reload before saving.",{status:409});
    if (JSON.stringify(stored.pcbSnapshots ?? []) !== JSON.stringify(input.pcbSnapshots ?? [])) throw new Response("Use the PCB snapshot import operation to change imported evidence", {status:400});
    if (JSON.stringify(stored.printPackages ?? []) !== JSON.stringify(input.printPackages ?? [])) throw new Response("Use the print plate operation to record sliced evidence", {status:400});
    if (JSON.stringify(stored.workspace) !== JSON.stringify(input.workspace)) throw new Response("Use workspace build operations to change revision records", {status:400});
  }
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
  const previousAssembly = JSON.parse(previous.data).assembly as Assembly | undefined;
  checkSavedFiles(next.assembly, previousAssembly);
  const guard = JSON.stringify(next.assembly) !== JSON.stringify(previousAssembly) ? await assemblyGuard(db,next) : undefined;
  const [updated] = await db
    .update(workshopProjects)
    .set({
      name: next.name,
      purpose: next.purpose,
      revision: next.revision,
      data: JSON.stringify(next),
      ...revisionColumns(next),
      updatedBy: identity.userId,
      updatedAt: next.updatedAt,
    })
    .where(
      and(
        eq(workshopProjects.id, id),
        eq(workshopProjects.revision, input.revision), guard,
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
  const guard = JSON.stringify(next.assembly) !== JSON.stringify(current.assembly) ? await assemblyGuard(db,next) : undefined;
  const [updated] = await db
    .update(workshopProjects)
    .set({
      name: next.name,
      purpose: next.purpose,
      revision: next.revision,
      data: JSON.stringify(next),
      ...revisionColumns(next),
      updatedBy: identity.userId,
      updatedAt: next.updatedAt,
    })
    .where(and(eq(workshopProjects.id, id), eq(workshopProjects.revision, revision), guard))
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
  return patchWorkshopProject(db, identity, { id, revision }, current => {
    checkSavedFiles(assembly, current.assembly);
    return { assembly };
  });
}

export async function exportWorkshopProject(db: WorkshopDatabase, id: string) {
  const project = await getWorkshopProject(db, id);
  const bom = project.assembly.items.some(item => item.reference)
    ? (await resolvedProject(db, {projectId: id, revision: project.revision})).assembly : project.assembly;
  return new Response(new Uint8Array(projectPackage(project, bom)).buffer, {
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
  const guard=await assemblyGuard(db,await getWorkshopProject(db,id),true);
  const [deleted] = await db
    .delete(workshopProjects)
    .where(
      and(
        eq(workshopProjects.id, id),
        eq(workshopProjects.revision, revision), guard, noConsumers(id),
      ),
    )
    .returning({ id: workshopProjects.id });
  if (!deleted)
    throw new Response(
      "Project changed or another assembly references it. Reload before deleting.",
      { status: 409 },
    );
  return id;
}
